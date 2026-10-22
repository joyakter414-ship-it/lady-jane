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
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidGroup,
  isPnUser,
  jidDecode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  proto,
  useMultiFileAuthState,
  WAMessageStubType,
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
const HEARTBEAT_MS = 25_000;

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
        name:
          sock.user?.notify ||
          sock.user?.name ||
          sock.user?.verifiedName ||
          sock.authState?.creds?.me?.name ||
          sock.authState?.creds?.me?.notify ||
          null,
      };
      log.info(`✅ Connected to WhatsApp as ${me.name ?? ""} (+${jidDecode(me.pn)?.user ?? "?"})`);
      await setState("open");
      await backupNow(log);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log.warn("Logged out reported from WhatsApp. Standing by; remote session kept safe unless reset from dashboard.");
        // Protect saved session from being wiped unintentionally!
        // Cloud session can only be permanently unlinked from the web dashboard.
        await setState("logged_out", { detail: "WhatsApp session logged out. Reconnect or reset from dashboard." });
        scheduleRestart(10_000);
      } else if (code === DisconnectReason.connectionReplaced) {
        // Another gateway instance took over the session — do NOT overwrite the active instance's "open" status in KV!
        log.warn("Connection replaced: another Lady Jane gateway instance is active. Standing by for 60s.");
        scheduleRestart(60_000);
      } else {
        const isFastRetry =
          code === DisconnectReason.restartRequired ||
          code === DisconnectReason.timedOut ||
          code === 408 ||
          code === 515;
        const delay = isFastRetry ? 1_000 : Math.min(5_000, 1_500 * Math.min(4, ++reconnectAttempts));
        log.warn(`Connection closed (code ${code ?? "unknown"}). Reconnecting in ${Math.round(delay / 1000)}s…`);
        scheduleRestart(delay);
      }
    }
  });

  sock.ev.on("contacts.upsert", (contacts) => {
    for (const c of contacts) {
      if (c && isMe(c.id)) {
        const contactName = c.notify || c.name || c.verifiedName;
        if (contactName && contactName !== me.name) {
          me.name = contactName;
          sendStatus();
        }
      }
    }
  });

  sock.ev.on("contacts.update", (updates) => {
    for (const c of updates) {
      if (c && isMe(c.id)) {
        const contactName = c.notify || c.name || c.verifiedName;
        if (contactName && contactName !== me.name) {
          me.name = contactName;
          sendStatus();
        }
      }
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    // Process both 'notify' (incoming) and 'append' (outgoing from user phone / WhatsApp web)
    if (type !== "notify" && type !== "append") return;
    for (const msg of messages) {
      onMessage(msg).catch((err) => log.error({ err: String(err), stack: err?.stack }, "Failed to handle message"));
    }
  });

  sock.ev.on("messages.update", async (updates) => {
    for (const update of updates) {
      const isRevoke =
        update.update?.messageStubType === WAMessageStubType.REVOKE ||
        update.update?.messageStubType === WAMessageStubType.ADMIN_REVOKE ||
        update.update?.message === null;
      if (isRevoke) {
        const targetId = update.key?.id;
        const targetChat = update.key?.remoteJid;
        const fromMe = Boolean(update.key?.fromMe);
        if (targetId && targetChat) {
          log.info({ targetId, targetChat, fromMe }, "⚠️ messages.update REVOKE detected! Preserving in DB.");
          await brain("POST", "/gw/message", {
            json: {
              id: `revoke_${targetId}_${Date.now()}`,
              chatId: jidNormalizedUser(targetChat),
              isGroup: isJidGroup(targetChat),
              isSelfChat: false,
              fromMe,
              text: "[Message deleted]",
              isRevoke: true,
              revokedMsgId: targetId,
              revokedBy: fromMe ? "you" : "sender",
              timestamp: Date.now(),
            },
          }).catch((err) => log.error({ err: String(err) }, "Failed to report revoke"));
        }
      }
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

function detectMedia(message) {
  const m = normalizeMessageContent(message);
  if (!m) return null;
  if (m.imageMessage) {
    return {
      type: "image",
      mime: m.imageMessage.mimetype || "image/jpeg",
      ext: "jpg",
      caption: m.imageMessage.caption || "",
    };
  }
  if (m.audioMessage) {
    return {
      type: "audio",
      mime: m.audioMessage.mimetype || "audio/ogg; codecs=opus",
      ext: m.audioMessage.ptt ? "ogg" : "mp3",
      caption: m.audioMessage.ptt ? "🎤 Voice message" : "🎵 Audio",
    };
  }
  if (m.videoMessage) {
    return {
      type: "video",
      mime: m.videoMessage.mimetype || "video/mp4",
      ext: "mp4",
      caption: m.videoMessage.caption || "🎥 Video",
    };
  }
  if (m.documentMessage) {
    const fn = m.documentMessage.fileName || "document";
    const ext = fn.includes(".") ? fn.split(".").pop() : "bin";
    return {
      type: "document",
      mime: m.documentMessage.mimetype || "application/octet-stream",
      ext,
      caption: m.documentMessage.caption || `📄 ${fn}`,
    };
  }
  if (m.stickerMessage) {
    return {
      type: "sticker",
      mime: m.stickerMessage.mimetype || "image/webp",
      ext: "webp",
      caption: "🎨 Sticker",
    };
  }
  return null;
}

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

const isMe = (jid) => {
  if (!jid) return false;
  const norm = jidNormalizedUser(jid);
  if ([me.pn, me.lid].filter(Boolean).includes(norm)) return true;
  const p = phoneOf(jid);
  const myP = phoneOf(me.pn);
  return Boolean(p && myP && p === myP);
};
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
  if (!msg.message && !msg.messageStubType) return;

  const sentAt = Number(msg.messageTimestamp || 0) * 1000;
  if (sentAt && Date.now() - sentAt > MAX_MESSAGE_AGE_MS) return;

  const isGroup = !!isJidGroup(chatJid);
  const isSelfChat = !isGroup && (isMe(chatJid) || isMe(key.remoteJidAlt));

  // 1. Check for protocol revoke / unsend ("Delete for Everyone"):
  const mContent = normalizeMessageContent(msg.message);
  const protocolMsg = mContent?.protocolMessage;
  if (
    protocolMsg &&
    (protocolMsg.type === proto.Message.ProtocolMessage.Type.REVOKE ||
      protocolMsg.type === 0 ||
      protocolMsg.type === 14)
  ) {
    const targetId = protocolMsg.key?.id;
    const targetChat = protocolMsg.key?.remoteJid || chatJid;
    const targetFromMe = Boolean(protocolMsg.key?.fromMe);
    if (targetId) {
      log.info({ targetId, targetChat, targetFromMe }, "⚠️ Protocol unsend/revoke detected! Preserving original message in DB with deleted tag.");
      await brain("POST", "/gw/message", {
        json: {
          id: key.id,
          chatId: jidNormalizedUser(targetChat),
          isGroup: isJidGroup(targetChat),
          isSelfChat: !isJidGroup(targetChat) && (isMe(targetChat) || isMe(key.remoteJidAlt)),
          fromMe: targetFromMe,
          senderPhone: isJidGroup(targetChat) ? phoneOf(key.participant, key.participantAlt) : phoneOf(targetChat, key.remoteJidAlt),
          senderName: targetFromMe ? me.name : msg.pushName || null,
          text: "[Message deleted]",
          isRevoke: true,
          revokedMsgId: targetId,
          revokedBy: targetFromMe ? "you" : "sender",
          timestamp: sentAt || Date.now(),
        },
      }).catch((err) => log.error({ err: String(err) }, "Failed to report protocol revoke"));
      return;
    }
  }

  // 2. Download media (image, voice, video, document, sticker) and upload directly to R2:
  const mediaInfo = detectMedia(msg.message);
  let mediaUrl = null;
  let mediaType = mediaInfo?.type || null;
  let mediaMime = mediaInfo?.mime || null;

  if (mediaInfo) {
    try {
      log.info({ type: mediaInfo.type, id: key.id }, "📥 Downloading media from WhatsApp...");
      const buffer = await downloadMediaMessage(
        msg,
        "buffer",
        {},
        { logger: waLog, reuploadRequest: sock.updateMediaMessage }
      );
      if (buffer && buffer.length > 0) {
        const cleanChat = (isGroup ? chatJid : phoneOf(chatJid, key.remoteJidAlt) || chatJid).replace(/[^a-zA-Z0-9_-]/g, "_");
        const objectKey = `media/${cleanChat}/${key.id}.${mediaInfo.ext}`;
        log.info({ objectKey, size: buffer.length }, "☁️ Uploading media directly to Cloudflare R2...");
        await brain("PUT", `/gw/media?key=${encodeURIComponent(objectKey)}&mime=${encodeURIComponent(mediaInfo.mime)}`, {
          body: buffer,
          headers: { "content-type": mediaInfo.mime },
        });
        mediaUrl = objectKey;
        log.info({ objectKey }, "✅ Media uploaded to R2 successfully!");
      }
    } catch (err) {
      log.error({ err: String(err), id: key.id }, "Failed to download/upload media to R2");
    }
  }

  let text = extractText(msg.message);
  if (!text && mediaInfo) {
    text = mediaInfo.caption || `[${mediaInfo.type.toUpperCase()}]`;
  }
  if (!text && !mediaInfo) return;

  if (key.fromMe && msg.pushName && (!me.name || me.name !== msg.pushName)) {
    me.name = msg.pushName;
    sendStatus().catch(() => {});
  }
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
    text: (text || "").slice(0, 4000),
    mentioned,
    timestamp: sentAt || Date.now(),
    mediaType,
    mediaUrl,
    mediaMime,
  };

  const decision = await brain("POST", "/gw/message", { json: payload });
  if (decision?.action !== "reply" || !decision.reply) {
    log.info({ chat: payload.chatId, from: payload.senderPhone, text: payload.text, reason: decision?.reason }, "Message ignored by brain");
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
    if (Array.isArray(res?.outbound) && res.outbound.length > 0 && sock && state === "open") {
      for (const item of res.outbound) {
        await sendOutboundItem(item);
      }
    }
  } catch (err) {
    log.warn({ err: String(err) }, "Could not reach the brain");
  }
}

async function sendOutboundItem(item) {
  if (!item?.jid || !item?.text || !sock || state !== "open") return;
  try {
    await sock.sendPresenceUpdate("composing", item.jid).catch(() => {});
    await new Promise((r) => setTimeout(r, 350));
    const sent = await sock.sendMessage(item.jid, { text: item.text });
    rememberSent(sent?.key?.id);
    await sock.sendPresenceUpdate("paused", item.jid).catch(() => {});
    log.info(`📤 Direct message sent to ${item.jid} from dashboard: "${item.text.slice(0, 50)}"`);
  } catch (err) {
    log.error({ err: String(err), jid: item.jid }, "Failed to send outbound message from dashboard");
  }
}

async function checkOutbound() {
  if (!sock || state !== "open") return;
  try {
    const res = await brain("GET", "/gw/outbound", { retries: 0 });
    if (Array.isArray(res?.outbound) && res.outbound.length > 0) {
      for (const item of res.outbound) {
        await sendOutboundItem(item);
      }
    }
  } catch {}
}

// Check for direct outbound dashboard messages every 2.5s for near-instant delivery
setInterval(checkOutbound, 2500).unref();

// Always send heartbeats every 25s (including while in "qr" state) so dashboard never drops offline
setInterval(() => sendStatus(), HEARTBEAT_MS).unref();

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

