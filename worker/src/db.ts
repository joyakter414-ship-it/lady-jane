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
  media_type?: string | null;
  media_url?: string | null;
  media_mime?: string | null;
  deleted_at?: number | null;
  deleted_by?: string | null;
  reactions?: string | null;
  quoted_id?: string | null;
  quoted_text?: string | null;
  quoted_sender?: string | null;
  edited_at?: number | null;
  edit_history?: string | null;
}

/**
 * Insert a message. Returns false if a message with the same id already
 * exists — that's how duplicate WhatsApp deliveries are ignored.
 */
export async function insertMessage(env: AppEnv, m: Omit<StoredMessage, "model" | "neurons"> & Partial<StoredMessage>): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (
       id, chat_id, role, sender, sender_name, content, source,
       model, neurons, created_at, media_type, media_url, media_mime,
       deleted_at, deleted_by, reactions, quoted_id, quoted_text, quoted_sender,
       edited_at, edit_history
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      m.id,
      m.chat_id,
      m.role,
      m.sender,
      m.sender_name,
      m.content,
      m.source,
      m.model ?? null,
      m.neurons ?? null,
      m.created_at,
      m.media_type ?? null,
      m.media_url ?? null,
      m.media_mime ?? null,
      m.deleted_at ?? 0,
      m.deleted_by ?? null,
      m.reactions ?? "[]",
      m.quoted_id ?? null,
      m.quoted_text ?? null,
      m.quoted_sender ?? null,
      m.edited_at ?? 0,
      m.edit_history ?? "[]"
    )
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export interface ReactionItem {
  emoji: string;
  sender: string;
  fromMe: boolean;
  at?: number;
}

export async function updateMessageReaction(
  env: AppEnv,
  chatId: string,
  targetId: string,
  reaction: ReactionItem
): Promise<void> {
  const cleanTargetId = targetId.includes(":") ? targetId.split(":").pop()! : targetId;
  const row = await env.DB.prepare(
    `SELECT id, reactions FROM messages 
     WHERE (id = ?1 OR id = ?2 OR id LIKE '%:' || ?3)`
  )
    .bind(`wa:${chatId}:${cleanTargetId}`, targetId, cleanTargetId)
    .first<{ id: string; reactions: string }>();

  if (!row) return;

  let list: ReactionItem[] = [];
  try {
    list = row.reactions ? JSON.parse(row.reactions) : [];
  } catch {
    list = [];
  }

  // Remove prior reaction by this sender perspective
  list = list.filter((r) => r.fromMe !== reaction.fromMe);

  // If emoji is not empty, add it
  if (reaction.emoji && reaction.emoji.trim()) {
    list.push({
      emoji: reaction.emoji.trim(),
      sender: reaction.sender,
      fromMe: reaction.fromMe,
      at: reaction.at || Date.now(),
    });
  }

  await env.DB.prepare("UPDATE messages SET reactions = ? WHERE id = ?")
    .bind(JSON.stringify(list), row.id)
    .run();
}

export async function updateMessageContent(
  env: AppEnv,
  chatId: string,
  targetId: string,
  newContent: string,
  editedAt: number
): Promise<boolean> {
  const cleanTargetId = targetId.includes(":") ? targetId.split(":").pop()! : targetId;
  const row = await env.DB.prepare(
    `SELECT id, content, edit_history FROM messages 
     WHERE (id = ?1 OR id = ?2 OR id LIKE '%:' || ?3)`
  )
    .bind(`wa:${chatId}:${cleanTargetId}`, targetId, cleanTargetId)
    .first<{ id: string; content: string; edit_history: string }>();

  if (!row) return false;

  let history: Array<{ text: string; edited_at: number }> = [];
  try {
    history = row.edit_history ? JSON.parse(row.edit_history) : [];
  } catch {
    history = [];
  }

  // Preserve the previous content in edit_history!
  history.push({
    text: row.content,
    edited_at: editedAt || Date.now(),
  });

  const res = await env.DB.prepare(
    `UPDATE messages 
     SET content = ?1, edited_at = ?2, edit_history = ?3
     WHERE id = ?4`
  )
    .bind(newContent, editedAt || Date.now(), JSON.stringify(history), row.id)
    .run();

  return (res.meta.changes ?? 0) > 0;
}

/**
 * Mark a message as unsend/deleted by sender or user without removing the content or media.
 */
export async function markMessageDeleted(
  env: AppEnv,
  chatId: string,
  targetId: string,
  deletedBy: string,
  deletedAt: number
): Promise<boolean> {
  const cleanTargetId = targetId.includes(":") ? targetId.split(":").pop()! : targetId;
  const fullId = `wa:${chatId}:${cleanTargetId}`;
  const res = await env.DB.prepare(
    `UPDATE messages 
     SET deleted_at = ?1, deleted_by = ?2
     WHERE (id = ?3 OR id = ?4 OR id LIKE '%:' || ?5) AND (deleted_at IS NULL OR deleted_at = 0)`
  )
    .bind(deletedAt, deletedBy, fullId, targetId, cleanTargetId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Automatically purge heavy files (images, audio, video) older than X days from Cloudflare R2
 */
export async function cleanupOldMedia(env: AppEnv, days = 10): Promise<{ deletedCount: number }> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const { results } = await env.DB.prepare(
    "SELECT id, media_url FROM messages WHERE created_at < ? AND media_url IS NOT NULL LIMIT 100"
  )
    .bind(cutoff)
    .all<{ id: string; media_url: string }>();

  if (!results || results.length === 0) return { deletedCount: 0 };

  for (const item of results) {
    if (item.media_url) {
      await env.BUCKET.delete(item.media_url).catch(() => {});
    }
  }

  await env.DB.prepare(
    "UPDATE messages SET media_url = NULL WHERE created_at < ? AND media_url IS NOT NULL"
  )
    .bind(cutoff)
    .run();

  return { deletedCount: results.length };
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

export async function upsertChat(
  env: AppEnv,
  chatId: string,
  name: string | null = null,
  notifyName: string | null = null,
  phone: string | null = null,
  isGroup: boolean = false
): Promise<{ muted: boolean }> {
  const row = await env.DB.prepare(
    `INSERT INTO chats (chat_id, name, notify_name, phone, is_group, last_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(chat_id) DO UPDATE SET
       name = COALESCE(?2, name),
       notify_name = COALESCE(?3, notify_name),
       phone = COALESCE(?4, phone),
       last_at = ?6
     RETURNING muted`,
  )
    .bind(chatId, name, notifyName, phone, isGroup ? 1 : 0, Date.now())
    .first<{ muted: number }>();
  return { muted: Boolean(row?.muted) };
}

export async function updateContacts(
  env: AppEnv,
  contacts: Array<{ id: string; name?: string; notify?: string; phone?: string }>
): Promise<void> {
  const stmts = [];
  for (const c of contacts) {
    if (!c?.id) continue;
    const name = c.name?.trim() || null;
    const notify = c.notify?.trim() || null;
    const phone = c.phone || (c.id.includes("@s.whatsapp.net") ? c.id.split("@")[0] : null);
    if (!name && !notify && !phone) continue;

    const cleanName = name && (name.includes("@gmail") || name.toLowerCase() === "sadia") ? null : name;
    const cleanNotify = notify && (notify.includes("@gmail") || notify.toLowerCase() === "sadia") ? null : notify;

    stmts.push(
      env.DB.prepare(
        `UPDATE chats SET
           name = COALESCE(?1, name),
           notify_name = COALESCE(?2, notify_name),
           phone = COALESCE(?3, phone)
         WHERE chat_id = ?4 OR chat_id = ?5`,
      ).bind(cleanName, cleanNotify, phone, c.id, phone ? `${phone}@s.whatsapp.net` : c.id)
    );
  }
  for (let i = 0; i < stmts.length; i += 50) {
    const chunk = stmts.slice(i, i + 50);
    if (chunk.length > 0) {
      await env.DB.batch(chunk).catch(() => {});
    }
  }
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

