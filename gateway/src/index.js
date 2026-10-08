// Lady Jane — WhatsApp gateway.
//
// Links to your WhatsApp as a "Linked device" (like WhatsApp Web), forwards
// incoming text messages to the Lady Jane brain on Cloudflare, and sends her
// replies back. All decisions (who to answer, what to say) are made by the
// brain, so you control everything from the dashboard.

import { createServer } from "node:http";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  isPnUser,
  jidDecode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import qrTerminal from "qrcode-terminal";
import { brain } from "./brain.js";
import { AUTH_DIR, backupNow, restoreSession, scheduleBackup, wipeSession } from "./session-store.js";

const log = pino({ level: process.env.LOG_LEVEL || "info", transport: undefined });
// Baileys is very chatty; keep its own logs quiet unless debugging.
const waLog = log.child({ module: "baileys" }, { level: process.env.BAILEYS_LOG_LEVEL || "warn" });

/** Don't answer messages older than this (e.g. backlog delivered after downtime). */
const MAX_MESSAGE_AGE_MS = 10 * 60_000;
/** Safety valve against reply loops / floods: max replies per chat per minute. */
const MAX_REPLIES_PER_MINUTE = 8;
const HEARTBEAT_MS = 30_000;

let sock = null;
let state = "starting";
let me = { pn: null, lid: null, name: null };
let reconnectAttempts = 0;
let restartTimer = null;
const sentIds = new Set(); // ids of messages Lady Jane sent, so she never answers herself
const replyLog = new Map(); // chatJid -> timestamps of recent replies
const groupNames = new Map();

// ─── Connection ──────────────────────────────────────────────────────────────

async function start() {
  clearTimeout(restartTimer);
  await setState("connecting");
  await restoreSession(log);

  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const keys = {
    get: (type, ids) => auth.keys.get(type, ids),
    set: async (data) => {
      await auth.keys.set(data);
      scheduleBackup(log);
    },
  };
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  sock = makeWASocket({
    version,
    auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(keys, waLog) },
    logger: waLog,
    browser: Browsers.ubuntu("Chrome"),
    // Stay "offline" so your phone keeps receiving notifications as normal.
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async () => undefined,
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    scheduleBackup(log);
  });

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      log.info("Scan this QR in WhatsApp → Settings → Linked devices → Link a device (also shown on the dashboard):");
      qrTerminal.generate(qr, { small: true });
      await setState("qr", { qr: await QRCode.toDataURL(qr, { margin: 1, width: 320 }) });
    }

    if (connection === "open") {
      reconnectAttempts = 0;
      me = {
        pn: sock.user?.id ? jidNormalizedUser(sock.user.id) : null,
        lid: sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null,
        name: sock.user?.name ?? null,
      };
      log.info(`✅ Connected to WhatsApp as ${me.name ?? ""} (+${jidDecode(me.pn)?.user ?? "?"})`);
      await setState("open");
      await backupNow(log);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log.warn("Logged out from WhatsApp. Clearing session — a new QR code will appear.");
        await wipeSession(log);
        await setState("logged_out");
        scheduleRestart(2_000);
      } else if (code === DisconnectReason.connectionReplaced) {
        // Another gateway instance is using the same session. Don't fight it.
        log.error("Connection replaced: another Lady Jane gateway is running with this session. Retrying in 2 min.");
        await setState("closed", { detail: "Another gateway took over this session" });
        scheduleRestart(120_000);
      } else {
        const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(60_000, 2_000 * 2 ** reconnectAttempts++);
        log.warn(`Connection closed (code ${code ?? "unknown"}). Reconnecting in ${Math.round(delay / 1000)}s…`);
        await setState("closed", { detail: `Disconnected (code ${code ?? "unknown"}), reconnecting` });
        scheduleRestart(delay);
      }
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      onMessage(msg).catch((err) => log.error({ err: String(err), stack: err?.stack }, "Failed to handle message"));
    }
  });
}

function scheduleRestart(delay) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => start().catch(fatalRetry), delay);
}

function fatalRetry(err) {
  log.error({ err: String(err) }, "Gateway start failed; retrying in 15s");
  scheduleRestart(15_000);
}

// ─── Messages ────────────────────────────────────────────────────────────────

function extractText(message) {
  const m = normalizeMessageContent(message);
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ""
  ).trim();
}

function contextInfoOf(message) {
  const m = normalizeMessageContent(message);
  if (!m) return undefined;
  for (const value of Object.values(m)) {
    if (value && typeof value === "object" && value.contextInfo) return value.contextInfo;
  }
  return undefined;
}

const isMe = (jid) => !!jid && [me.pn, me.lid].includes(jidNormalizedUser(jid));
const phoneOf = (...jids) => {
  const pn = jids.find((j) => j && isPnUser(j));
  return pn ? jidDecode(pn)?.user ?? null : null;
};

async function groupName(jid) {
  if (groupNames.has(jid)) return groupNames.get(jid);
  const name = await sock.groupMetadata(jid).then((g) => g.subject).catch(() => null);
  groupNames.set(jid, name);
  return name;
}

function underRateLimit(chatJid) {
  const now = Date.now();
  const recent = (replyLog.get(chatJid) || []).filter((t) => now - t < 60_000);
  replyLog.set(chatJid, recent);
  return recent.length < MAX_REPLIES_PER_MINUTE;
}

function rememberSent(id) {
  if (!id) return;
  sentIds.add(id);
  if (sentIds.size > 1000) sentIds.delete(sentIds.values().next().value);
}

async function onMessage(msg) {
  const key = msg.key;
  const chatJid = key?.remoteJid;
  if (!key?.id || !chatJid || sentIds.has(key.id)) return;
  if (chatJid === "status@broadcast" || chatJid.endsWith("@broadcast") || chatJid.endsWith("@newsletter")) return;
  if (!msg.message || msg.messageStubType) return;

  const text = extractText(msg.message);
  if (!text) return; // text only for now (voice/images can come later)

  const sentAt = Number(msg.messageTimestamp || 0) * 1000;
  if (sentAt && Date.now() - sentAt > MAX_MESSAGE_AGE_MS) return;

  const isGroup = !!isJidGroup(chatJid);
  const isSelfChat = !isGroup && (isMe(chatJid) || isMe(key.remoteJidAlt));
  const ctx = contextInfoOf(msg.message);
  const mentioned = isGroup && (
    (ctx?.mentionedJid || []).some(isMe) ||
    isMe(ctx?.participant) // replying to one of Lady Jane's messages
  );

  const payload = {
    id: key.id,
    chatId: isGroup ? chatJid : jidNormalizedUser(isPnUser(chatJid) ? chatJid : key.remoteJidAlt || chatJid),
    chatName: isGroup ? await groupName(chatJid) : msg.pushName || null,
    isGroup,
    isSelfChat,
    fromMe: !!key.fromMe,
    senderPhone: isGroup ? phoneOf(key.participant, key.participantAlt) : phoneOf(chatJid, key.remoteJidAlt),
    senderName: key.fromMe ? me.name : msg.pushName || null,
    text: text.slice(0, 4000),
    mentioned,
    timestamp: sentAt || Date.now(),
  };

  const decision = await brain("POST", "/gw/message", { json: payload });
  if (decision?.action !== "reply" || !decision.reply) {
    log.debug({ chat: payload.chatId, reason: decision?.reason }, "Ignored");
    return;
  }
  if (!underRateLimit(chatJid)) {
    log.warn({ chat: payload.chatId }, "Rate limit hit — not replying");
    return;
  }

  await sock.readMessages([key]).catch(() => {});
  await sock.sendPresenceUpdate("composing", chatJid).catch(() => {});
  const sent = await sock.sendMessage(chatJid, { text: decision.reply }, isGroup ? { quoted: msg } : undefined);
  rememberSent(sent?.key?.id);
  replyLog.get(chatJid).push(Date.now());
  await sock.sendPresenceUpdate("paused", chatJid).catch(() => {});
  log.info(`💬 Replied in ${isSelfChat ? "your self-chat" : payload.chatName || payload.chatId}${decision.neurons ? ` (${decision.neurons.toFixed(1)} neurons)` : ""}`);
}

// ─── Status, heartbeat, health ───────────────────────────────────────────────

async function setState(next, extra = {}) {
  state = next;
  await sendStatus(extra);
}

async function sendStatus(extra = {}) {
  try {
    const res = await brain("POST", "/gw/status", {
      retries: 0,
      json: {
        state,
        me: me.pn ? { id: me.pn, name: me.name, phone: jidDecode(me.pn)?.user } : null,
        ...extra,
      },
    });
    if (res?.command === "logout" && sock && state === "open") {
      log.warn("Logout requested from the dashboard.");
      await sock.logout().catch((err) => log.error({ err: String(err) }, "Logout failed"));
    }
  } catch (err) {
    log.warn({ err: String(err) }, "Could not reach the brain");
  }
}

// Re-send the latest QR with each heartbeat isn't needed (WhatsApp rotates it
// and Baileys emits a new one), so heartbeats only carry state.
setInterval(() => state !== "qr" && sendStatus(), HEARTBEAT_MS).unref();

const port = Number(process.env.PORT || 8080);
createServer((req, res) => {
  res.writeHead(state === "open" ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify({ name: "lady-jane-gateway", state, connectedAs: me.pn ? `+${jidDecode(me.pn)?.user}` : null }));
}).listen(port, () => log.info(`Health check on http://localhost:${port}`));

async function shutdown(signal) {
  log.info(`${signal} received — saving session and exiting.`);
  await backupNow(log);
  await setState("closed", { detail: "Gateway stopped" });
  sock?.end(undefined);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// GitHub Actions 24/7 continuous relay:
// GitHub jobs have a ~6h runtime limit. At 5 hours, automatically dispatch the next runner.
// Concurrency (cancel-in-progress: true) will seamlessly replace this runner with zero downtime.
if (process.env.GH_PAT && process.env.GITHUB_REPOSITORY) {
  const RELAY_AFTER_MS = 5 * 60 * 60 * 1000; // 5 hours
  setTimeout(async () => {
    log.info("🔄 5 hours elapsed. Dispatching next GitHub relay runner for continuous 24/7 uptime...");
    try {
      const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/gateway.yml/dispatches`, {
        method: "POST",
        headers: {
          Authorization: `token ${process.env.GH_PAT}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Lady-Jane-Gateway",
        },
        body: JSON.stringify({ ref: "main" }),
      });
      log.info(`Relay runner dispatched: HTTP ${res.status}`);
    } catch (e) {
      log.error({ err: String(e) }, "Failed to trigger relay runner");
    }
  }, RELAY_AFTER_MS).unref();
}

log.info("👑 Lady Jane gateway starting…");
start().catch(fatalRetry);

