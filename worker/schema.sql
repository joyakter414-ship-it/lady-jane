-- Lady Jane — D1 schema. Safe to re-run.

-- Every message Lady Jane handled (incoming + her replies). Messages she
-- ignores are never stored, so unrelated private chats stay out of the DB.
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,          -- WhatsApp message id (also used for de-duplication)
  chat_id     TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  sender      TEXT,                      -- phone digits, when known
  sender_name TEXT,
  content     TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'whatsapp',  -- 'whatsapp' | 'dashboard'
  model       TEXT,
  neurons     REAL,
  created_at  INTEGER NOT NULL,          -- unix ms
  media_type  TEXT,                      -- 'image' | 'audio' | 'video' | 'document' | 'sticker'
  media_url   TEXT,                      -- R2 object key
  media_mime  TEXT,                      -- mimetype
  deleted_at  INTEGER DEFAULT 0,         -- unsend timestamp if deleted
  deleted_by  TEXT                       -- 'sender' | 'you'
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, created_at);

CREATE TABLE IF NOT EXISTS chats (
  chat_id    TEXT PRIMARY KEY,
  name       TEXT,
  is_group   INTEGER NOT NULL DEFAULT 0,
  muted      INTEGER NOT NULL DEFAULT 0,
  last_at    INTEGER NOT NULL
);

-- Daily Neuron usage, so the dashboard can show it against the 10,000/day free allocation.
CREATE TABLE IF NOT EXISTS usage (
  day      TEXT PRIMARY KEY,             -- YYYY-MM-DD (UTC, same as Cloudflare's reset)
  neurons  REAL NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0
);

-- Small key/value store: settings, gateway status, pending gateway commands.
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
