// Talks to the Lady Jane brain (Cloudflare Worker).

const BRAIN_URL = (process.env.BRAIN_URL || "").replace(/\/+$/, "");
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || "";

if (!BRAIN_URL || !GATEWAY_TOKEN) {
  console.error("Missing BRAIN_URL or GATEWAY_TOKEN. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

/**
 * Call the brain. Retries network errors and 5xx responses a couple of times;
 * 4xx responses are returned/thrown immediately since retrying won't help.
 */
export async function brain(method, path, { json, body, raw = false, retries = 2 } = {}) {
  const headers = { authorization: `Bearer ${GATEWAY_TOKEN}` };
  if (json !== undefined) headers["content-type"] = "application/json";
  const init = { method, headers, body: json !== undefined ? JSON.stringify(json) : body };

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${BRAIN_URL}${path}`, { ...init, signal: AbortSignal.timeout(60_000) });
      if (res.status === 404 && raw) return null;
      if (res.status >= 500 && attempt < retries) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`${method} ${path} → HTTP ${res.status}: ${await res.text()}`), { fatal: true });
      return raw ? Buffer.from(await res.arrayBuffer()) : await res.json();
    } catch (err) {
      if (err.fatal || attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}
