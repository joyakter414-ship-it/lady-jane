import type { AppEnv } from "./env";
import { kvGet } from "./db";

export interface GDriveConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folderId?: string;
  folderName?: string;
  account?: string;
}

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

export async function getGDriveConfig(env: AppEnv): Promise<GDriveConfig | null> {
  const cfg = await kvGet<GDriveConfig>(env, "gdrive_config").catch(() => null);
  if (cfg && cfg.enabled && cfg.refreshToken) {
    return cfg;
  }
  return null;
}

export async function getGDriveAccessToken(env: AppEnv): Promise<string | null> {
  const cfg = await getGDriveConfig(env);
  if (!cfg) return null;

  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.token;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("GDrive OAuth token refresh failed:", res.status, errText);
    return null;
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) return null;

  cachedAccessToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };

  return data.access_token;
}

export async function uploadToGoogleDrive(
  env: AppEnv,
  filename: string,
  mime: string,
  buffer: ArrayBuffer | Uint8Array,
): Promise<{ id: string; viewUrl: string } | null> {
  const cfg = await getGDriveConfig(env);
  if (!cfg) return null;

  const accessToken = await getGDriveAccessToken(env);
  if (!accessToken) return null;

  const boundary = "-------LadyJaneDriveBoundary314159";
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const metadata: any = {
    name: filename,
    mimeType: mime,
  };
  if (cfg.folderId) {
    metadata.parents = [cfg.folderId];
  }

  const metaPart = `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`;
  const mediaHeader = `${delimiter}Content-Type: ${mime}\r\nContent-Transfer-Encoding: binary\r\n\r\n`;

  const metaBytes = new TextEncoder().encode(metaPart);
  const mediaHeaderBytes = new TextEncoder().encode(mediaHeader);
  const closeBytes = new TextEncoder().encode(closeDelimiter);
  const bodyBytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  const fullLength = metaBytes.length + mediaHeaderBytes.length + bodyBytes.length + closeBytes.length;
  const combined = new Uint8Array(fullLength);
  let offset = 0;
  combined.set(metaBytes, offset);
  offset += metaBytes.length;
  combined.set(mediaHeaderBytes, offset);
  offset += mediaHeaderBytes.length;
  combined.set(bodyBytes, offset);
  offset += bodyBytes.length;
  combined.set(closeBytes, offset);

  const uploadRes = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body: combined,
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    console.error("GDrive upload failed:", uploadRes.status, errText);
    return null;
  }

  const fileData = (await uploadRes.json()) as { id?: string };
  if (!fileData?.id) return null;

  // Make public read permission so high-speed Google CDN URLs work directly
  fetch(`https://www.googleapis.com/drive/v3/files/${fileData.id}/permissions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      role: "reader",
      type: "anyone",
    }),
  }).catch(() => {});

  return {
    id: fileData.id,
    viewUrl: `https://lh3.googleusercontent.com/d/${fileData.id}`,
  };
}

export async function streamFromGoogleDrive(
  env: AppEnv,
  fileId: string,
  rangeHeader?: string | null,
): Promise<Response> {
  const accessToken = await getGDriveAccessToken(env);
  if (!accessToken) {
    return new Response("Google Drive authorization unavailable", { status: 503 });
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };
  if (rangeHeader) {
    headers["Range"] = rangeHeader;
  }

  const driveRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers,
  });

  if (!driveRes.ok && driveRes.status !== 206) {
    return new Response("Failed to fetch media from Google Drive", { status: driveRes.status });
  }

  const responseHeaders = new Headers();
  const forwardHeaders = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ];
  for (const h of forwardHeaders) {
    const val = driveRes.headers.get(h);
    if (val) responseHeaders.set(h, val);
  }
  if (!responseHeaders.has("accept-ranges")) {
    responseHeaders.set("accept-ranges", "bytes");
  }
  responseHeaders.set("cache-control", "public, max-age=31536000, immutable");

  return new Response(driveRes.body, {
    status: driveRes.status,
    headers: responseHeaders,
  });
}
