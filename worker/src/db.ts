import type { AppEnv } from "./env";

export async function kvGet<T>(env: AppEnv, key: string): Promise<T | null> {
  const row = await env.DB.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : null;
}

export async function kvSet(env: AppEnv, key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3",
  )
    .bind(key, JSON.stringify(value), Date.now())
    .run();
}

export async function kvDelete(env: AppEnv, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM kv WHERE key = ?").bind(key).run();
}

export interface StoredMessage {
  id: string;
  chat_id: string;
  role: "user" | "assistant";
  sender: string | null;
  sender_name: string | null;
  content: string;
  source: string;
  model: string | null;
  neurons: number | null;
  created_at: number;
}

/**
 * Insert a message. Returns false if a message with the same id already
 * exists — that's how duplicate WhatsApp deliveries are ignored.
 */
export async function insertMessage(env: AppEnv, m: Omit<StoredMessage, "model" | "neurons"> & Partial<StoredMessage>): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (id, chat_id, role, sender, sender_name, content, source, model, neurons, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(m.id, m.chat_id, m.role, m.sender, m.sender_name, m.content, m.source, m.model ?? null, m.neurons ?? null, m.created_at)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function recentMessages(env: AppEnv, chatId: string, limit: number, excludeId?: string): Promise<StoredMessage[]> {
  if (limit <= 0) return [];
  const { results } = await env.DB.prepare(
    "SELECT * FROM messages WHERE chat_id = ? AND id != ? ORDER BY created_at DESC LIMIT ?",
  )
    .bind(chatId, excludeId ?? "", limit)
    .all<StoredMessage>();
  return results.reverse();
}

export async function upsertChat(env: AppEnv, chatId: string, name: string | null, isGroup: boolean): Promise<{ muted: boolean }> {
  const row = await env.DB.prepare(
    `INSERT INTO chats (chat_id, name, is_group, last_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(chat_id) DO UPDATE SET name = COALESCE(?2, name), last_at = ?4
     RETURNING muted`,
  )
    .bind(chatId, name, isGroup ? 1 : 0, Date.now())
    .first<{ muted: number }>();
  return { muted: Boolean(row?.muted) };
}

export async function addUsage(env: AppEnv, neurons: number | undefined): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO usage (day, neurons, requests) VALUES (?1, ?2, 1)
     ON CONFLICT(day) DO UPDATE SET neurons = neurons + ?2, requests = requests + 1`,
  )
    .bind(day, neurons ?? 0)
    .run();
}

export interface Rule {
  id: string;
  type: "instant" | "ai_guideline";
  triggers: string;
  response: string;
  enabled: number;
  created_at: number;
}

export async function getRules(env: AppEnv): Promise<Rule[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM rules ORDER BY created_at DESC"
  ).all<Rule>();
  return results;
}

export async function getEnabledRules(env: AppEnv): Promise<Rule[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM rules WHERE enabled = 1 ORDER BY created_at DESC"
  ).all<Rule>();
  return results;
}

export async function createRule(
  env: AppEnv,
  r: { type: "instant" | "ai_guideline"; triggers: string; response: string; enabled?: boolean }
): Promise<Rule> {
  const id = `rule_${crypto.randomUUID().slice(0, 8)}`;
  const enabled = r.enabled !== false ? 1 : 0;
  const created_at = Date.now();
  await env.DB.prepare(
    `INSERT INTO rules (id, type, triggers, response, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, r.type, r.triggers.trim(), r.response.trim(), enabled, created_at)
    .run();
  return { id, type: r.type, triggers: r.triggers.trim(), response: r.response.trim(), enabled, created_at };
}

export async function updateRule(
  env: AppEnv,
  id: string,
  patch: Partial<Pick<Rule, "type" | "triggers" | "response" | "enabled">>
): Promise<Rule | null> {
  const existing = await env.DB.prepare("SELECT * FROM rules WHERE id = ?").bind(id).first<Rule>();
  if (!existing) return null;
  const updated: Rule = {
    ...existing,
    type: patch.type ?? existing.type,
    triggers: patch.triggers !== undefined ? patch.triggers.trim() : existing.triggers,
    response: patch.response !== undefined ? patch.response.trim() : existing.response,
    enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
  };
  await env.DB.prepare(
    `UPDATE rules SET type = ?, triggers = ?, response = ?, enabled = ? WHERE id = ?`
  )
    .bind(updated.type, updated.triggers, updated.response, updated.enabled, id)
    .run();
  return updated;
}

export async function deleteRule(env: AppEnv, id: string): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

