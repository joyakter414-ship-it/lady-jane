import type { AppEnv } from "./env";
import { handleDashboardChat, handleIncoming, type IncomingMessage } from "./brain";
import { createRule, deleteRule, getRules, kvDelete, kvGet, kvSet, updateRule } from "./db";
import { getSettings, MODELS, saveSettings, type Settings } from "./settings";

const SESSION_KEY = "whatsapp/session.bin";
const FREE_NEURONS_PER_DAY = 10_000;
/** Gateway sends a heartbeat every 30s; after this long without one it's shown offline. */
const GATEWAY_OFFLINE_AFTER_MS = 90_000;

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
      return json({ error: "Internal error" }, 500);
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
      return json({ ok: true, command: command?.cmd ?? null });
    }
    case "GET /gw/session": {
      const obj = await env.BUCKET.get(SESSION_KEY);
      if (!obj) return new Response(null, { status: 404 });
      return new Response(obj.body, { headers: { "content-type": "application/octet-stream" } });
    }
    case "PUT /gw/session": {
      // The gateway encrypts the session before upload; we only store the bytes.
      await env.BUCKET.put(SESSION_KEY, await request.arrayBuffer());
      return json({ ok: true });
    }
    case "DELETE /gw/session": {
      await env.BUCKET.delete(SESSION_KEY);
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
    case "POST /api/gateway/logout": {
      await kvSet(env, "gateway_command", { cmd: "logout" });
      return json({ ok: true, note: "The gateway will log out of WhatsApp on its next heartbeat (within ~30s)." });
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
