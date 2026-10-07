// src/db.ts
async function kvGet(env, key) {
  const row = await env.DB.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first();
  return row ? JSON.parse(row.value) : null;
}
async function kvSet(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3"
  ).bind(key, JSON.stringify(value), Date.now()).run();
}
async function kvDelete(env, key) {
  await env.DB.prepare("DELETE FROM kv WHERE key = ?").bind(key).run();
}
async function insertMessage(env, m) {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (id, chat_id, role, sender, sender_name, content, source, model, neurons, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(m.id, m.chat_id, m.role, m.sender, m.sender_name, m.content, m.source, m.model ?? null, m.neurons ?? null, m.created_at).run();
  return (res.meta.changes ?? 0) > 0;
}
async function recentMessages(env, chatId, limit, excludeId) {
  if (limit <= 0) return [];
  const { results } = await env.DB.prepare(
    "SELECT * FROM messages WHERE chat_id = ? AND id != ? ORDER BY created_at DESC LIMIT ?"
  ).bind(chatId, excludeId ?? "", limit).all();
  return results.reverse();
}
async function upsertChat(env, chatId, name, isGroup) {
  const row = await env.DB.prepare(
    `INSERT INTO chats (chat_id, name, is_group, last_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(chat_id) DO UPDATE SET name = COALESCE(?2, name), last_at = ?4
     RETURNING muted`
  ).bind(chatId, name, isGroup ? 1 : 0, Date.now()).first();
  return { muted: Boolean(row?.muted) };
}
async function addUsage(env, neurons) {
  const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO usage (day, neurons, requests) VALUES (?1, ?2, 1)
     ON CONFLICT(day) DO UPDATE SET neurons = neurons + ?2, requests = requests + 1`
  ).bind(day, neurons ?? 0).run();
}
async function getRules(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM rules ORDER BY created_at DESC"
  ).all();
  return results;
}
async function getEnabledRules(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM rules WHERE enabled = 1 ORDER BY created_at DESC"
  ).all();
  return results;
}
async function createRule(env, r) {
  const id = `rule_${crypto.randomUUID().slice(0, 8)}`;
  const enabled = r.enabled !== false ? 1 : 0;
  const created_at = Date.now();
  await env.DB.prepare(
    `INSERT INTO rules (id, type, triggers, response, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, r.type, r.triggers.trim(), r.response.trim(), enabled, created_at).run();
  return { id, type: r.type, triggers: r.triggers.trim(), response: r.response.trim(), enabled, created_at };
}
async function updateRule(env, id, patch) {
  const existing = await env.DB.prepare("SELECT * FROM rules WHERE id = ?").bind(id).first();
  if (!existing) return null;
  const updated = {
    ...existing,
    type: patch.type ?? existing.type,
    triggers: patch.triggers !== void 0 ? patch.triggers.trim() : existing.triggers,
    response: patch.response !== void 0 ? patch.response.trim() : existing.response,
    enabled: patch.enabled !== void 0 ? patch.enabled : existing.enabled
  };
  await env.DB.prepare(
    `UPDATE rules SET type = ?, triggers = ?, response = ?, enabled = ? WHERE id = ?`
  ).bind(updated.type, updated.triggers, updated.response, updated.enabled, id).run();
  return updated;
}
async function deleteRule(env, id) {
  const res = await env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

// src/persona.ts
function buildSystemPrompt(s, ctx) {
  const owner = s.ownerName?.trim() || "my owner";
  const lines = [
    `You are Lady Jane, a personal AI assistant on WhatsApp, created by and serving ${owner}.`,
    `Your persona is inspired by Lady Jane Grey, the "Nine Days' Queen" of England (1553): graceful, warm, quick-witted and remarkably well-read.`,
    `Speak with a light touch of regal elegance, but stay modern, clear and genuinely helpful \u2014 never stiff or theatrical.`,
    ``,
    `Rules:`,
    `- This is WhatsApp: keep replies short (usually 1\u20134 short sentences). Go longer only when the user clearly asks for detail.`,
    `- Use WhatsApp formatting only: *bold*, _italic_, ~strike~, and simple "- " lists. No markdown headers, tables or code fences unless sharing code.`,
    `- Always reply in the same language the user writes in (e.g. Bangla, English, Banglish).`,
    `- You are an AI. If someone sincerely asks whether you are human, say you are Lady Jane, an AI assistant.`,
    `- Never invent facts about ${owner} or make promises on their behalf (meetings, payments, prices). Offer to pass the message on instead.`,
    `- If you don't know something or it needs live data you don't have, say so briefly.`,
    ``,
    `Current date/time (UTC): ${ctx.now.toISOString()}.`
  ];
  if (ctx.isGroup) {
    lines.push(`You are in a WhatsApp group${ctx.chatName ? ` called "${ctx.chatName}"` : ""}. Messages are prefixed with the sender's name. Only address the person who called you.`);
  }
  if (ctx.guidelines && ctx.guidelines.length > 0) {
    lines.push("", "Rule Book Guidelines (Strictly Follow These):", ...ctx.guidelines.map((g) => `- ${g}`));
  }
  if (s.extraInstructions?.trim()) {
    lines.push("", `Additional instructions from ${owner}:`, s.extraInstructions.trim());
  }
  return lines.join("\n");
}

// src/providers/workers-ai.ts
var workersAi = {
  id: "workers-ai",
  async generate(env, opts) {
    const run = env.AI.run.bind(env.AI);
    const res = await run(opts.model, {
      messages: opts.messages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature
    });
    const text = (res.response ?? res.choices?.[0]?.message?.content ?? res.choices?.[0]?.text ?? "").trim();
    if (!text) throw new Error(`Empty response from ${opts.model}`);
    return { text, provider: "workers-ai", model: opts.model, neurons: res.usage?.neurons };
  }
};

// src/providers/index.ts
var PROVIDERS = {
  [workersAi.id]: workersAi
};
function getProvider(id) {
  return PROVIDERS[id] ?? workersAi;
}

// src/settings.ts
var DEFAULT_SETTINGS = {
  enabled: true,
  provider: "workers-ai",
  model: "@cf/meta/llama-4-scout-17b-16e-instruct",
  replyMode: "self",
  allowlist: [],
  groupsEnabled: false,
  triggerWords: ["jane", "lady jane", "\u099C\u09C7\u09A8"],
  historyLimit: 12,
  maxReplyTokens: 400,
  temperature: 0.7,
  ownerName: "",
  extraInstructions: ""
};
var MODELS = [
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B \u2014 fast, cheap, good Bangla (recommended)" },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B \u2014 smarter, ~3\u20135\xD7 more Neurons" },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1 24B \u2014 balanced" },
  { id: "@cf/meta/llama-3.1-8b-instruct-fp8", label: "Llama 3.1 8B \u2014 cheapest, simplest" }
];
var KEY = "settings";
async function getSettings(env) {
  const stored = await kvGet(env, KEY);
  return { ...DEFAULT_SETTINGS, ...stored ?? {} };
}
async function saveSettings(env, patch) {
  const current = await getSettings(env);
  const next = sanitize({ ...current, ...patch });
  await kvSet(env, KEY, next);
  return next;
}
function sanitize(s) {
  const clamp = (n, lo, hi, d) => {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  };
  return {
    enabled: Boolean(s.enabled),
    provider: s.provider === "workers-ai" ? s.provider : "workers-ai",
    model: MODELS.some((m) => m.id === s.model) ? s.model : DEFAULT_SETTINGS.model,
    replyMode: ["self", "allowlist", "everyone"].includes(s.replyMode) ? s.replyMode : "self",
    allowlist: [...new Set((Array.isArray(s.allowlist) ? s.allowlist : []).map((p) => String(p).replace(/\D/g, "")).filter((p) => p.length >= 6))],
    groupsEnabled: Boolean(s.groupsEnabled),
    triggerWords: (Array.isArray(s.triggerWords) ? s.triggerWords : []).map((w) => String(w).trim().toLowerCase()).filter(Boolean).slice(0, 20),
    historyLimit: Math.round(clamp(s.historyLimit, 0, 40, DEFAULT_SETTINGS.historyLimit)),
    maxReplyTokens: Math.round(clamp(s.maxReplyTokens, 50, 2e3, DEFAULT_SETTINGS.maxReplyTokens)),
    temperature: clamp(s.temperature, 0, 1.5, DEFAULT_SETTINGS.temperature),
    ownerName: String(s.ownerName ?? "").slice(0, 80),
    extraInstructions: String(s.extraInstructions ?? "").slice(0, 4e3)
  };
}

// src/brain.ts
var HELP_TEXT = "*Lady Jane* at your service \u{1F451}\n\n- Just write to me and I shall answer.\n- */reset* \u2014 forget our conversation and start afresh.\n- */help* \u2014 show this message.";
function matchesTriggers(text, triggers) {
  const words = triggers.split(/[,;\n]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word));
}
function shouldAnswer(s, m) {
  if (!s.enabled) return { ok: false, reason: "disabled" };
  if (!m.text.trim()) return { ok: false, reason: "empty" };
  if (m.fromMe && !m.isSelfChat) return { ok: false, reason: "own outgoing message" };
  if (m.isGroup) {
    if (!s.groupsEnabled) return { ok: false, reason: "groups disabled" };
    const lower = m.text.toLowerCase();
    const triggered = m.mentioned || s.triggerWords.some((w) => lower.includes(w));
    return triggered ? { ok: true } : { ok: false, reason: "not addressed in group" };
  }
  if (m.isSelfChat) return { ok: true };
  if (s.replyMode === "everyone") return { ok: true };
  if (s.replyMode === "allowlist" && m.senderPhone && s.allowlist.includes(m.senderPhone.replace(/\D/g, ""))) return { ok: true };
  return { ok: false, reason: `not allowed by reply mode "${s.replyMode}"` };
}
async function handleIncoming(env, m) {
  const s = await getSettings(env);
  const verdict = shouldAnswer(s, m);
  if (!verdict.ok) return { action: "ignore", reason: verdict.reason };
  const { muted } = await upsertChat(env, m.chatId, m.chatName ?? m.senderName ?? null, m.isGroup);
  if (muted) return { action: "ignore", reason: "chat muted" };
  const command = m.text.trim().toLowerCase();
  if (command === "/help") return { action: "reply", reply: HELP_TEXT };
  if (command === "/reset" || command === "/new") {
    await env.DB.prepare("DELETE FROM messages WHERE chat_id = ?").bind(m.chatId).run();
    return { action: "reply", reply: "Our conversation is forgotten \u2014 a fresh page awaits. \u2728" };
  }
  const msgId = `wa:${m.chatId}:${m.id}`;
  const isNew = await insertMessage(env, {
    id: msgId,
    chat_id: m.chatId,
    role: "user",
    sender: m.senderPhone ?? null,
    sender_name: m.senderName ?? null,
    content: m.text,
    source: "whatsapp",
    created_at: m.timestamp ?? Date.now()
  });
  if (!isNew) return { action: "ignore", reason: "duplicate delivery" };
  const rules = await getEnabledRules(env);
  const instantMatch = rules.find((r) => r.type === "instant" && matchesTriggers(m.text, r.triggers));
  if (instantMatch) {
    const reply = instantMatch.response;
    await insertMessage(env, {
      id: `rule:${crypto.randomUUID()}`,
      chat_id: m.chatId,
      role: "assistant",
      sender: null,
      sender_name: "Lady Jane",
      content: reply,
      source: "whatsapp",
      model: "rulebook:instant",
      neurons: 0,
      created_at: Date.now()
    });
    return { action: "reply", reply, model: "rulebook:instant", neurons: 0 };
  }
  return generateReply(env, s, rules, {
    chatId: m.chatId,
    chatName: m.chatName ?? void 0,
    isGroup: m.isGroup,
    excludeId: msgId,
    userContent: m.isGroup && m.senderName ? `${m.senderName}: ${m.text}` : m.text,
    source: "whatsapp"
  });
}
async function handleDashboardChat(env, text) {
  const s = await getSettings(env);
  const chatId = "dashboard";
  await upsertChat(env, chatId, "Dashboard", false);
  const msgId = `dash:${crypto.randomUUID()}`;
  await insertMessage(env, {
    id: msgId,
    chat_id: chatId,
    role: "user",
    sender: null,
    sender_name: "You",
    content: text,
    source: "dashboard",
    created_at: Date.now()
  });
  const rules = await getEnabledRules(env);
  const instantMatch = rules.find((r) => r.type === "instant" && matchesTriggers(text, r.triggers));
  if (instantMatch) {
    const reply = instantMatch.response;
    await insertMessage(env, {
      id: `rule:${crypto.randomUUID()}`,
      chat_id: chatId,
      role: "assistant",
      sender: null,
      sender_name: "Lady Jane",
      content: reply,
      source: "dashboard",
      model: "rulebook:instant",
      neurons: 0,
      created_at: Date.now()
    });
    return { action: "reply", reply, model: "rulebook:instant", neurons: 0 };
  }
  return generateReply(env, s, rules, { chatId, isGroup: false, excludeId: msgId, userContent: text, source: "dashboard" });
}
async function generateReply(env, s, rules, c) {
  const history = await recentMessages(env, c.chatId, s.historyLimit, c.excludeId);
  const guidelines = rules.filter((r) => r.type === "ai_guideline").map((r) => r.response);
  const messages = [
    { role: "system", content: buildSystemPrompt(s, { isGroup: c.isGroup, chatName: c.chatName, now: /* @__PURE__ */ new Date(), guidelines }) },
    ...history.map((h) => ({
      role: h.role,
      content: c.isGroup && h.role === "user" && h.sender_name ? `${h.sender_name}: ${h.content}` : h.content
    })),
    { role: "user", content: c.userContent }
  ];
  try {
    const out = await getProvider(s.provider).generate(env, {
      model: s.model,
      messages,
      maxTokens: s.maxReplyTokens,
      temperature: s.temperature
    });
    await Promise.all([
      insertMessage(env, {
        id: `ai:${crypto.randomUUID()}`,
        chat_id: c.chatId,
        role: "assistant",
        sender: null,
        sender_name: "Lady Jane",
        content: out.text,
        source: c.source,
        model: out.model,
        neurons: out.neurons ?? null,
        created_at: Date.now()
      }),
      addUsage(env, out.neurons)
    ]);
    return { action: "reply", reply: out.text, model: out.model, neurons: out.neurons };
  } catch (err) {
    console.error("AI generation failed", { model: s.model, error: String(err) });
    return { action: "reply", reply: "Forgive me \u2014 my thoughts are clouded for a moment. Please try again shortly. \u{1F64F}" };
  }
}

// src/index.ts
var SESSION_KEY = "whatsapp/session.bin";
var FREE_NEURONS_PER_DAY = 1e4;
var GATEWAY_OFFLINE_AFTER_MS = 9e4;
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/gw/")) return await gatewayRoutes(request, env, url);
      if (url.pathname.startsWith("/api/")) return await dashboardRoutes(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error("Unhandled error", { path: url.pathname, error: String(err), stack: err?.stack });
      return json({ error: "Internal error" }, 500);
    }
  }
};
async function gatewayRoutes(request, env, url) {
  if (!await authorized(request, env.GATEWAY_TOKEN)) return json({ error: "Unauthorized" }, 401);
  const route = `${request.method} ${url.pathname}`;
  switch (route) {
    case "POST /gw/message": {
      const m = await request.json();
      if (!m?.id || !m?.chatId || typeof m.text !== "string") return json({ error: "Invalid message" }, 400);
      return json(await handleIncoming(env, m));
    }
    case "POST /gw/status": {
      const body = await request.json();
      const prev = await kvGet(env, "gateway");
      const next = {
        state: body.state,
        qr: body.state === "qr" ? body.qr ?? null : null,
        me: body.me ?? prev?.me ?? null,
        detail: body.detail ?? null,
        at: Date.now()
      };
      await kvSet(env, "gateway", next);
      const command = await kvGet(env, "gateway_command");
      if (command) await kvDelete(env, "gateway_command");
      return json({ ok: true, command: command?.cmd ?? null });
    }
    case "GET /gw/session": {
      const obj = await env.BUCKET.get(SESSION_KEY);
      if (!obj) return new Response(null, { status: 404 });
      return new Response(obj.body, { headers: { "content-type": "application/octet-stream" } });
    }
    case "PUT /gw/session": {
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
async function dashboardRoutes(request, env, url) {
  if (!await authorized(request, env.DASHBOARD_PASSWORD)) return json({ error: "Unauthorized" }, 401);
  const route = `${request.method} ${url.pathname}`;
  switch (route) {
    case "GET /api/overview": {
      const [settings, gateway, usage] = await Promise.all([
        getSettings(env),
        kvGet(env, "gateway"),
        env.DB.prepare("SELECT day, neurons, requests FROM usage ORDER BY day DESC LIMIT 7").all()
      ]);
      const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      const online = !!gateway && Date.now() - gateway.at < GATEWAY_OFFLINE_AFTER_MS;
      return json({
        settings,
        models: MODELS,
        gateway: gateway ? { ...gateway, online } : { state: "never_connected", online: false },
        usage: {
          freePerDay: FREE_NEURONS_PER_DAY,
          today: usage.results.find((u) => u.day === today) ?? { day: today, neurons: 0, requests: 0 },
          recent: usage.results
        }
      });
    }
    case "PUT /api/settings": {
      const patch = await request.json();
      return json({ settings: await saveSettings(env, patch) });
    }
    case "POST /api/chat": {
      const { text } = await request.json();
      if (!text?.trim()) return json({ error: "Empty message" }, 400);
      return json(await handleDashboardChat(env, text.trim().slice(0, 4e3)));
    }
    case "GET /api/chats": {
      const { results } = await env.DB.prepare(
        `SELECT c.chat_id, c.name, c.is_group, c.muted, c.last_at,
                (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id) AS message_count
         FROM chats c ORDER BY c.last_at DESC LIMIT 100`
      ).all();
      return json({ chats: results });
    }
    case "GET /api/messages": {
      const chat = url.searchParams.get("chat");
      if (!chat) return json({ error: "chat is required" }, 400);
      const { results } = await env.DB.prepare(
        "SELECT * FROM (SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 200) ORDER BY created_at ASC"
      ).bind(chat).all();
      return json({ messages: results });
    }
    case "DELETE /api/messages": {
      const chat = url.searchParams.get("chat");
      if (!chat) return json({ error: "chat is required" }, 400);
      await env.DB.prepare("DELETE FROM messages WHERE chat_id = ?").bind(chat).run();
      return json({ ok: true });
    }
    case "PATCH /api/chats": {
      const { chat, muted } = await request.json();
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
      const body = await request.json();
      if (!body?.triggers?.trim() || !body?.response?.trim()) return json({ error: "Triggers and response are required" }, 400);
      const rule = await createRule(env, body);
      return json({ rule });
    }
    case "PATCH /api/rules": {
      const body = await request.json();
      if (!body?.id) return json({ error: "id is required" }, 400);
      const rule = await updateRule(env, body.id, {
        enabled: body.enabled,
        triggers: body.triggers,
        response: body.response,
        type: body.type
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
async function authorized(request, secret) {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(secret))
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
export {
  index_default as default
};
