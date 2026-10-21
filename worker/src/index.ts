import type { AppEnv } from "./env";
import { handleDashboardChat, handleIncoming, type IncomingMessage } from "./brain";
import { createRule, deleteRule, getRules, insertMessage, kvDelete, kvGet, kvSet, updateRule, upsertChat } from "./db";
import { getSettings, MODELS, saveSettings, type Settings } from "./settings";

const SESSION_KEY = "whatsapp/session.bin";
const SESSION_KV_KEY = "whatsapp_session_b64";
const FREE_NEURONS_PER_DAY = 10_000;
/** Gateway sends a heartbeat every 25s; allow up to 3 minutes before marking offline. */
const GATEWAY_OFFLINE_AFTER_MS = 180_000;

interface GatewayStatus {
  state: "starting" | "connecting" | "qr" | "open" | "closed" | "logged_out";
  qr?: string | null;
  me?: { id?: string; name?: string; phone?: string } | null;
  detail?: string | null;
  at: number;
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/gw/")) return await gatewayRoutes(request, env, url);
      if (url.pathname.startsWith("/api/")) return await dashboardRoutes(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error("Unhandled error", { path: url.pathname, error: String(err), stack: (err as Error)?.stack });
      return json({ error: (err as Error)?.message || "Internal error" }, 500);
    }
  },
} satisfies ExportedHandler<AppEnv>;

// ─── Gateway (WhatsApp connector) ────────────────────────────────────────────

async function gatewayRoutes(request: Request, env: AppEnv, url: URL): Promise<Response> {
  if (!(await authorized(request, env.GATEWAY_TOKEN))) return json({ error: "Unauthorized" }, 401);
  const route = `${request.method} ${url.pathname}`;

  switch (route) {
    case "POST /gw/message": {
      const m = (await request.json()) as IncomingMessage;
      if (!m?.id || !m?.chatId || typeof m.text !== "string") return json({ error: "Invalid message" }, 400);
      return json(await handleIncoming(env, m));
    }
    case "POST /gw/status": {
      const body = (await request.json()) as Omit<GatewayStatus, "at">;
      const prev = await kvGet<GatewayStatus>(env, "gateway");
      const next: GatewayStatus = {
        state: body.state,
        qr: body.state === "qr" ? body.qr ?? null : null,
        me: body.me ?? prev?.me ?? null,
        detail: body.detail ?? null,
        at: Date.now(),
      };
      await kvSet(env, "gateway", next);
      // Hand any pending dashboard command (e.g. logout) back to the gateway.
      const command = await kvGet<{ cmd: string }>(env, "gateway_command");
      if (command) await kvDelete(env, "gateway_command");
      const outbound = (await kvGet<Array<{ id: string; jid: string; text: string }>>(env, "gateway_outbound_queue")) || [];
      if (outbound.length > 0) {
        await kvDelete(env, "gateway_outbound_queue");
      }
      return json({ ok: true, command: command?.cmd ?? null, outbound });
    }
    case "GET /gw/outbound": {
      const outbound = (await kvGet<Array<{ id: string; jid: string; text: string }>>(env, "gateway_outbound_queue")) || [];
      if (outbound.length > 0) {
        await kvDelete(env, "gateway_outbound_queue");
      }
      return json({ ok: true, outbound });
    }
    case "GET /gw/session": {
      const obj = await env.BUCKET.get(SESSION_KEY).catch(() => null);
      if (obj) {
        return new Response(obj.body, { headers: { "content-type": "application/octet-stream" } });
      }
      const b64 = await kvGet<string>(env, SESSION_KV_KEY).catch(() => null);
      if (b64) {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
      }
      return new Response(null, { status: 404 });
    }
    case "PUT /gw/session": {
      const buf = await request.arrayBuffer();
      // 1. Store encrypted session in Cloudflare R2
      await env.BUCKET.put(SESSION_KEY, buf).catch(() => {});
      // 2. Dual backup: also store in KV as base64 so session is NEVER lost across cold boots
      try {
        let binary = "";
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        await kvSet(env, SESSION_KV_KEY, btoa(binary));
      } catch {}
      return json({ ok: true });
    }
    case "DELETE /gw/session": {
      await Promise.all([
        env.BUCKET.delete(SESSION_KEY).catch(() => {}),
        kvDelete(env, SESSION_KV_KEY).catch(() => {}),
      ]);
      return json({ ok: true });
    }
  }
  return json({ error: "Not found" }, 404);
}

// ─── Dashboard API ───────────────────────────────────────────────────────────

async function dashboardRoutes(request: Request, env: AppEnv, url: URL): Promise<Response> {
  if (!(await authorized(request, env.DASHBOARD_PASSWORD))) return json({ error: "Unauthorized" }, 401);
  const route = `${request.method} ${url.pathname}`;

  switch (route) {
    case "GET /api/overview": {
      const [settings, gateway, usage] = await Promise.all([
        getSettings(env),
        kvGet<GatewayStatus>(env, "gateway"),
        env.DB.prepare("SELECT day, neurons, requests FROM usage ORDER BY day DESC LIMIT 7").all<{ day: string; neurons: number; requests: number }>(),
      ]);
      const today = new Date().toISOString().slice(0, 10);
      const online = !!gateway && Date.now() - gateway.at < GATEWAY_OFFLINE_AFTER_MS;
      return json({
        settings,
        models: MODELS,
        gateway: gateway ? { ...gateway, online } : { state: "never_connected", online: false },
        usage: {
          freePerDay: FREE_NEURONS_PER_DAY,
          today: usage.results.find((u) => u.day === today) ?? { day: today, neurons: 0, requests: 0 },
          recent: usage.results,
        },
      });
    }
    case "PUT /api/settings": {
      const patch = (await request.json()) as Partial<Settings>;
      return json({ settings: await saveSettings(env, patch) });
    }
    case "POST /api/chat": {
      const { text } = (await request.json()) as { text?: string };
      if (!text?.trim()) return json({ error: "Empty message" }, 400);
      return json(await handleDashboardChat(env, text.trim().slice(0, 4000)));
    }
    case "POST /api/messages/send": {
      const { chat, text } = (await request.json()) as { chat?: string; text?: string };
      if (!chat || !text?.trim()) return json({ error: "chat and text are required" }, 400);

      const s = await getSettings(env);
      const cleanText = text.trim().slice(0, 4000);
      const now = Date.now();
      const msgId = `dash-out:${crypto.randomUUID()}`;

      // 1. Immediately insert message into DB so conversations view updates instantly
      await insertMessage(env, {
        id: msgId,
        chat_id: chat,
        role: "assistant",
        sender: s.ownerName || "You",
        sender_name: s.ownerName || "You",
        content: cleanText,
        source: "dashboard-send",
        created_at: now,
      });

      // 2. Update chat timestamp in chats table
      await upsertChat(env, chat, null, chat.includes("@g.us"));

      // 3. Queue message for gateway runner to dispatch to WhatsApp socket
      const existingQueue = (await kvGet<Array<{ id: string; jid: string; text: string }>>(env, "gateway_outbound_queue")) || [];
      existingQueue.push({ id: msgId, jid: chat, text: cleanText });
      await kvSet(env, "gateway_outbound_queue", existingQueue);

      return json({ ok: true, id: msgId, text: cleanText, created_at: now });
    }
    case "GET /api/chats": {
      const { results } = await env.DB.prepare(
        `SELECT c.chat_id, c.name, c.is_group, c.muted, c.last_at,
                (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id) AS message_count
         FROM chats c ORDER BY c.last_at DESC LIMIT 100`,
      ).all();
      return json({ chats: results });
    }
    case "GET /api/messages": {
      const chat = url.searchParams.get("chat");
      if (!chat) return json({ error: "chat is required" }, 400);
      const { results } = await env.DB.prepare(
        "SELECT * FROM (SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 200) ORDER BY created_at ASC",
      )
        .bind(chat)
        .all();
      return json({ messages: results });
    }
    case "DELETE /api/messages": {
      const chat = url.searchParams.get("chat");
      if (!chat) return json({ error: "chat is required" }, 400);
      await env.DB.prepare("DELETE FROM messages WHERE chat_id = ?").bind(chat).run();
      return json({ ok: true });
    }
    case "PATCH /api/chats": {
      const { chat, muted } = (await request.json()) as { chat?: string; muted?: boolean };
      if (!chat) return json({ error: "chat is required" }, 400);
      await env.DB.prepare("UPDATE chats SET muted = ? WHERE chat_id = ?").bind(muted ? 1 : 0, chat).run();
      return json({ ok: true });
    }
    case "POST /api/gateway/start": {
      if (!env.GITHUB_PAT) {
        return json({ error: "GITHUB_PAT secret is not configured" }, 400);
      }
      const repo = env.GITHUB_REPO || "joyakter414-ship-it/lady-jane";
      try {
        const ghRes = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/gateway.yml/dispatches`, {
          method: "POST",
          headers: {
            "Authorization": `token ${env.GITHUB_PAT}`,
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "Lady-Jane-Brain",
          },
          body: JSON.stringify({ ref: "main" }),
        });
        if (!ghRes.ok) {
          const errText = await ghRes.text();
          return json({ error: `GitHub API error: ${ghRes.status} ${errText}` }, 500);
        }
        return json({ ok: true, message: "Lady Jane cloud runner dispatched! Connecting within 30-45 seconds." });
      } catch (err) {
        return json({ error: `Failed to dispatch runner: ${String(err)}` }, 500);
      }
    }
    case "POST /api/gateway/logout":
    case "POST /api/session/reset": {
      // 1. Permanently delete WhatsApp session from R2 storage and KV fallback
      await Promise.all([
        env.BUCKET.delete(SESSION_KEY).catch(() => {}),
        kvDelete(env, SESSION_KV_KEY).catch(() => {}),
      ]);
      // 2. Clear stored user identity in KV
      await kvSet(env, "gateway", {
        state: "logged_out",
        qr: null,
        me: null,
        detail: "WhatsApp unlinked by user. Scan new QR code to connect.",
        at: Date.now(),
      });
      // 3. Command any running gateway to disconnect and wipe local auth
      await kvSet(env, "gateway_command", { cmd: "logout" });
      return json({
        ok: true,
        note: "WhatsApp unlinked and session wiped from storage! A fresh QR code will appear to link your WhatsApp.",
      });
    }
    case "GET /api/rules": {
      return json({ rules: await getRules(env) });
    }
    case "POST /api/rules": {
      const body = (await request.json()) as { type: "instant" | "ai_guideline"; triggers: string; response: string; enabled?: boolean };
      if (!body?.triggers?.trim() || !body?.response?.trim()) return json({ error: "Triggers and response are required" }, 400);
      const rule = await createRule(env, body);
      return json({ rule });
    }
    case "PATCH /api/rules": {
      const body = (await request.json()) as { id: string; enabled?: number; triggers?: string; response?: string; type?: "instant" | "ai_guideline" };
      if (!body?.id) return json({ error: "id is required" }, 400);
      const rule = await updateRule(env, body.id, {
        enabled: body.enabled,
        triggers: body.triggers,
        response: body.response,
        type: body.type,
      });
      return json({ rule });
    }
    case "DELETE /api/rules": {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id is required" }, 400);
      await deleteRule(env, id);
      return json({ ok: true });
    }
  }
  return json({ error: "Not found" }, 404);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Constant-time check of `Authorization: Bearer <secret>`. */
async function authorized(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
