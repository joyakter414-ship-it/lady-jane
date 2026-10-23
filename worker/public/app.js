// Lady Jane dashboard. Plain JS, no build step.
// All user/WhatsApp content is inserted with textContent (never innerHTML).

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const fmtTime = (ms) => new Date(ms).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
const fmtNum = (n) => Math.round(n).toLocaleString();

let password = localStorage.getItem("lj_password") || "";
let overview = null;
let pollTimer = null;
let currentChat = null;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${password}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    signOut();
    throw new Error("Unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

function signOut() {
  password = "";
  localStorage.removeItem("lj_password");
  clearInterval(pollTimer);
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  password = $("#password").value;
  $("#login-error").textContent = "";
  try {
    await enterApp();
    localStorage.setItem("lj_password", password);
  } catch {
    $("#login-error").textContent = "That password is not recognised.";
  }
});
$("#logout").addEventListener("click", signOut);

async function enterApp() {
  await refreshOverview();
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    if (!$("#tab-home").classList.contains("hidden")) refreshOverview().catch(() => {});
    if (!$("#tab-chats").classList.contains("hidden")) {
      loadChats().catch(() => {});
      if (currentChat) {
        api("GET", `/api/messages?chat=${encodeURIComponent(currentChat.chat_id)}`).then(({ messages }) => {
          const log = $("#conv-log");
          const wasAtBottom = log.scrollHeight - log.scrollTop <= log.clientHeight + 50;
          log.replaceChildren(...messages.map(bubble));
          if (wasAtBottom) log.scrollTop = log.scrollHeight;
        }).catch(() => {});
      }
    }
  }, 4000);
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

document.querySelectorAll(".tab").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
    $(`#tab-${btn.dataset.tab}`).classList.remove("hidden");
    if (btn.dataset.tab === "home") refreshOverview();
    if (btn.dataset.tab === "chat") loadDashboardChat();
    if (btn.dataset.tab === "chats") loadChats();
    if (btn.dataset.tab === "rules") loadRules();
    if (btn.dataset.tab === "settings") fillSettings();
  }),
);

// ─── Home ────────────────────────────────────────────────────────────────────

const STATES = {
  open: ["on", "Connected"],
  qr: ["warn", "Waiting for you to scan the QR code"],
  connecting: ["warn", "Connecting…"],
  starting: ["warn", "Starting…"],
  closed: ["off", "Disconnected"],
  logged_out: ["off", "Logged out — new QR coming"],
  never_connected: ["off", "Gateway has never connected"],
};

async function refreshOverview() {
  overview = await api("GET", "/api/overview");
  const { gateway, usage, settings, models } = overview;

  const isOnline = Boolean(gateway.online);
  const isOpen = isOnline && gateway.state === "open";
  const isQr = isOnline && gateway.state === "qr" && Boolean(gateway.qr);
  const isPaused = Boolean(settings.instantReplyPaused);

  const displayName = gateway.me?.name || settings.ownerName || "";
  const phone = gateway.me?.phone;
  const fullAccountLabel = phone ? `+${phone}${displayName ? ` (${displayName})` : ""}` : "";

  // Topbar Status & Account Pill
  const topbarAccountPill = $("#topbar-account-pill");
  const topbarAccountText = $("#topbar-account-text");
  if (topbarAccountPill && topbarAccountText) {
    if (phone) {
      topbarAccountPill.classList.remove("hidden");
      topbarAccountText.textContent = fullAccountLabel;
    } else {
      topbarAccountPill.classList.add("hidden");
    }
  }

  const topbarInstantPill = $("#topbar-instant-pill");
  const topbarInstantText = $("#topbar-instant-text");
  if (topbarInstantPill && topbarInstantText) {
    if (isPaused) {
      topbarInstantPill.style.background = "rgba(234, 179, 8, 0.15)";
      topbarInstantPill.style.border = "1px solid rgba(234, 179, 8, 0.45)";
      topbarInstantPill.style.color = "#facc15";
      topbarInstantText.textContent = "⏸ Instant Reply: OFF";
      topbarInstantPill.title = "Currently instant reply is OFF (No AI replies). Click to turn ON.";
    } else {
      topbarInstantPill.style.background = "rgba(62, 207, 142, 0.15)";
      topbarInstantPill.style.border = "1px solid rgba(62, 207, 142, 0.45)";
      topbarInstantPill.style.color = "#3ecf8e";
      topbarInstantText.textContent = "⚡ Instant Reply: ON";
      topbarInstantPill.title = "Currently instant reply is ON (Automatic replies). Click to turn OFF.";
    }
    topbarInstantPill.onclick = toggleInstantReply;
  }

  let [dot, label] = STATES[gateway.state] || ["off", gateway.state];
  if (!isOnline && gateway.state !== "never_connected") {
    [dot, label] = ["off", "Gateway offline (runner sleeping)"];
  }
  const status = $("#wa-status");
  status.replaceChildren(el("span", `dot ${dot}`), el("span", null, label));
  if (isOpen && gateway.me?.phone) {
    status.append(el("span", "muted", ` as +${gateway.me.phone}${displayName ? ` (${displayName})` : ""}`));
  } else if (!isOnline && gateway.me?.phone) {
    status.append(el("span", "muted", ` (last linked: +${gateway.me.phone}${displayName ? ` - ${displayName}` : ""})`));
  }

  // Account details box
  const accountBox = $("#wa-account-box");
  if (accountBox) {
    const hasPhone = Boolean(gateway.me?.phone);
    accountBox.classList.toggle("hidden", !hasPhone);
    if (hasPhone) {
      if ($("#wa-account-phone")) $("#wa-account-phone").textContent = `+${gateway.me.phone}`;
      if ($("#wa-account-name")) $("#wa-account-name").textContent = displayName || "WhatsApp User";
    }
  }

  // Instant Reply Status Banner in WhatsApp Card
  const banner = $("#instant-reply-banner");
  const bannerText = $("#instant-reply-banner-text");
  const bannerBtn = $("#instant-reply-banner-btn");
  if (banner && bannerText && bannerBtn) {
    if (isPaused) {
      banner.style.background = "rgba(234, 179, 8, 0.12)";
      banner.style.border = "1px solid rgba(234, 179, 8, 0.4)";
      banner.style.color = "#facc15";
      bannerText.innerHTML = `<div><strong>⏸ Currently instant reply OFF — no reply from AI</strong><div style="font-size: 12px; margin-top: 3px; color: var(--muted);">Incoming messages are safely saved to Conversations. You can chat manually without AI interfering.</div></div>`;
      bannerBtn.textContent = "▶ Turn ON Instant Reply";
      bannerBtn.style.background = "var(--green)";
      bannerBtn.style.color = "#0b1a13";
      bannerBtn.style.border = "none";
    } else {
      banner.style.background = "rgba(62, 207, 142, 0.12)";
      banner.style.border = "1px solid rgba(62, 207, 142, 0.4)";
      banner.style.color = "#3ecf8e";
      bannerText.innerHTML = `<div><strong>⚡ Instant Reply is ON — AI answers immediately</strong><div style="font-size: 12px; margin-top: 3px; color: var(--muted);">Lady Jane will automatically reply to incoming WhatsApp messages using your AI persona.</div></div>`;
      bannerBtn.textContent = "⏸ Turn OFF Instant Reply";
      bannerBtn.style.background = "rgba(234, 179, 8, 0.25)";
      bannerBtn.style.color = "#facc15";
      bannerBtn.style.border = "1px solid rgba(234, 179, 8, 0.5)";
    }
    bannerBtn.onclick = toggleInstantReply;
  }

  // Conversations Tab Top Strip
  const convStrip = $("#conv-instant-strip");
  const convStripText = $("#conv-instant-strip-text");
  const convStripBtn = $("#conv-instant-strip-btn");
  if (convStrip && convStripText && convStripBtn) {
    if (isPaused) {
      convStrip.style.background = "rgba(234, 179, 8, 0.12)";
      convStrip.style.border = "1px solid rgba(234, 179, 8, 0.4)";
      convStrip.style.color = "#facc15";
      convStripText.innerHTML = `<div><strong>⏸ Currently instant reply OFF — no reply from AI</strong> (Manual Team Mode). Messages are live-synced below; type in the box to send replies directly to WhatsApp.</div>`;
      convStripBtn.textContent = "▶ Turn ON Instant Reply";
      convStripBtn.style.background = "var(--green)";
      convStripBtn.style.color = "#0b1a13";
      convStripBtn.style.border = "none";
    } else {
      convStrip.style.background = "rgba(62, 207, 142, 0.12)";
      convStrip.style.border = "1px solid rgba(62, 207, 142, 0.4)";
      convStrip.style.color = "#3ecf8e";
      convStripText.innerHTML = `<div><strong>⚡ Instant Reply is ON</strong> — Lady Jane is actively answering WhatsApp messages automatically.</div>`;
      convStripBtn.textContent = "⏸ Turn OFF Instant Reply";
      convStripBtn.style.background = "rgba(234, 179, 8, 0.25)";
      convStripBtn.style.color = "#facc15";
      convStripBtn.style.border = "1px solid rgba(234, 179, 8, 0.5)";
    }
    convStripBtn.onclick = toggleInstantReply;
  }

  // QR Code display
  $("#wa-qr").classList.toggle("hidden", !isQr);
  if (isQr && $("#wa-qr-img").src !== gateway.qr) {
    $("#wa-qr-img").src = gateway.qr;
  }

  // Status help / details
  $("#wa-help").textContent = !isOnline
    ? "Cloud runner is resting. Click 'Wake Up Cloud Gateway' below to start her instantly."
    : gateway.detail || (gateway.at ? `Last heartbeat ${fmtTime(gateway.at)}` : "");

  // Action buttons
  $("#wa-logout").classList.toggle("hidden", !isOpen);
  // Show reset if an account is linked or gateway previously connected
  const hasLinkedAccount = Boolean(gateway.me?.phone || gateway.state === "open");
  $("#wa-reset").classList.toggle("hidden", !hasLinkedAccount);
  $("#wa-wake").classList.toggle("hidden", isOnline);
  if ($("#wa-wake-head")) $("#wa-wake-head").classList.toggle("hidden", isOnline);

  $("#neurons-today").textContent = fmtNum(usage.today.neurons);
  $("#neurons-free").textContent = fmtNum(usage.freePerDay);
  $("#requests-today").textContent = usage.today.requests;
  $("#neurons-bar").style.width = `${Math.min(100, (usage.today.neurons / usage.freePerDay) * 100)}%`;
  $("#usage-rows").replaceChildren(
    ...usage.recent.map((u) => {
      const tr = el("tr");
      tr.append(el("td", null, u.day), el("td", null, `${u.requests} replies`), el("td", null, `${fmtNum(u.neurons)} neurons`));
      return tr;
    }),
  );

  $("#quick-enabled").checked = settings.enabled;

  // Quick switch toggle
  const quickInstantToggle = $("#quick-instant-toggle");
  const quickInstantLabel = $("#quick-instant-label");
  const quickInstantDesc = $("#quick-instant-desc");
  if (quickInstantToggle && quickInstantLabel && quickInstantDesc) {
    quickInstantToggle.checked = !isPaused; // Checked means ON
    if (isPaused) {
      quickInstantLabel.textContent = "Instant AI Replies: OFF";
      quickInstantLabel.style.color = "#facc15";
      quickInstantDesc.textContent = "⚠️ Currently instant reply OFF — no reply from AI (manual mode active).";
      quickInstantDesc.style.color = "#facc15";
    } else {
      quickInstantLabel.textContent = "Instant AI Replies: ON";
      quickInstantLabel.style.color = "var(--green)";
      quickInstantDesc.textContent = "🟢 Currently instant reply ON — AI answers incoming messages immediately.";
      quickInstantDesc.style.color = "var(--green)";
    }
  }

  $("#quick-mode").textContent = { self: "Only me", allowlist: "Me + chosen numbers", everyone: "Everyone" }[settings.replyMode];
  $("#quick-model").textContent = (models.find((m) => m.id === settings.model)?.label || settings.model).split(" — ")[0];
}

async function toggleInstantReply() {
  const currentPaused = Boolean(overview?.settings?.instantReplyPaused);
  await api("PUT", "/api/settings", { instantReplyPaused: !currentPaused });
  await refreshOverview();
  if (currentChat) openChat(currentChat);
}

$("#quick-enabled").addEventListener("change", async (e) => {
  await api("PUT", "/api/settings", { enabled: e.target.checked });
  refreshOverview();
});

$("#quick-instant-toggle")?.addEventListener("change", async (e) => {
  await api("PUT", "/api/settings", { instantReplyPaused: !e.target.checked });
  await refreshOverview();
  if (currentChat) openChat(currentChat);
});

async function wakeGateway() {
  const btn = $("#wa-wake");
  const headBtn = $("#wa-wake-head");
  if (btn) { btn.disabled = true; btn.textContent = "Waking up runner…"; }
  if (headBtn) { headBtn.disabled = true; headBtn.textContent = "Waking up…"; }
  try {
    const r = await api("POST", "/api/gateway/start");
    alert(r.message || "Lady Jane cloud runner dispatched! Connecting within 30-45 seconds.");
  } catch (err) {
    alert("Could not start cloud runner: " + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "▶ Wake Up Cloud Gateway"; }
    if (headBtn) { headBtn.disabled = false; headBtn.textContent = "▶ Wake Runner"; }
    await refreshOverview().catch(() => {});
  }
}

$("#wa-wake")?.addEventListener("click", wakeGateway);
$("#wa-wake-head")?.addEventListener("click", wakeGateway);

$("#wa-logout").addEventListener("click", async () => {
  if (!confirm("Sign out of WhatsApp? Lady Jane will disconnect and stop replying until you scan a new QR code.")) return;
  try {
    const r = await api("POST", "/api/gateway/logout");
    alert(r.note || "WhatsApp unlinked.");
    await refreshOverview();
  } catch (err) {
    alert("Error: " + err.message);
  }
});

$("#wa-reset").addEventListener("click", async () => {
  if (!confirm("Unlink and delete saved WhatsApp session from Cloud storage?\n\nUse this to connect a different WhatsApp account or reset your connection.")) return;
  try {
    const r = await api("POST", "/api/session/reset");
    alert(r.note || "Session deleted. Starting cloud runner for a new QR code...");
    await api("POST", "/api/gateway/start").catch(() => {});
    await refreshOverview();
  } catch (err) {
    alert("Error: " + err.message);
  }
});

// ─── Talk to her ─────────────────────────────────────────────────────────────

function bubble(m) {
  const isMe = m.role === "assistant";
  const b = el("div", `msg ${m.role}`);

  // Quoted reply indication (when replying to a message)
  if (m.quoted_text || m.quoted_id) {
    const quoteBox = el("div", "msg-quoted");
    const quoteSender = el("div", "msg-quoted-sender", m.quoted_sender || "Reply");
    const quoteContent = el("div", "msg-quoted-text", m.quoted_text || "[Message]");
    quoteBox.append(quoteSender, quoteContent);
    b.append(quoteBox);
  }

  // Anti-delete / Unsend Notice Tag
  if (m.deleted_at) {
    const delTime = fmtTime(m.deleted_at);
    const delBy = m.deleted_by === "you" ? "you" : "sender";
    const mediaLabel =
      m.media_type === "image"
        ? "Image"
        : m.media_type === "audio"
        ? "Voice message"
        : m.media_type === "video"
        ? "Video"
        : m.media_type === "document"
        ? "Document"
        : "Message";
    const delTag = el(
      "div",
      "deleted-tag",
      `⚠️ ${mediaLabel} deleted by ${delBy} [${delTime}]`
    );
    delTag.style.cssText =
      "display: block; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 6px; background: rgba(255, 107, 122, 0.18); color: #ff6b7a; border: 1px solid rgba(255, 107, 122, 0.4); margin-bottom: 6px; width: fit-content;";
    b.append(delTag);
  }

  // Media Player / Image / Voice
  const password = localStorage.getItem("lj_password") || "";
  if (m.media_url) {
    const mediaSrc = `/api/media?key=${encodeURIComponent(m.media_url)}&token=${encodeURIComponent(password)}`;
    if (m.media_type === "image" || m.media_type === "sticker") {
      const img = el("img", "msg-media-img");
      img.src = mediaSrc;
      img.alt = "WhatsApp image";
      img.loading = "lazy";
      img.style.cssText = "max-width: 100%; max-height: 320px; border-radius: 8px; display: block; margin: 6px 0; cursor: pointer;";
      img.onclick = () => window.open(mediaSrc, "_blank");
      b.append(img);
    } else if (m.media_type === "audio") {
      const audioContainer = el("div", "msg-media-audio-box");
      audioContainer.style.cssText = "margin: 6px 0; display: flex; flex-direction: column; gap: 4px;";
      const audioLabel = el("div", "small-text muted", "🎤 Voice Message:");
      const audio = el("audio", "msg-media-audio");
      audio.src = mediaSrc;
      audio.controls = true;
      audio.preload = "metadata";
      audio.style.cssText = "width: 100%; min-width: 230px; height: 38px;";
      audioContainer.append(audioLabel, audio);
      b.append(audioContainer);
    } else if (m.media_type === "video") {
      const video = el("video", "msg-media-video");
      video.src = mediaSrc;
      video.controls = true;
      video.preload = "metadata";
      video.style.cssText = "max-width: 100%; max-height: 320px; border-radius: 8px; display: block; margin: 6px 0;";
      b.append(video);
    } else if (m.media_type === "document") {
      const docLink = el("a", "msg-media-doc", `📄 Download ${m.content || "Document"}`);
      docLink.href = mediaSrc;
      docLink.target = "_blank";
      docLink.style.cssText = "display: inline-block; margin: 6px 0; color: var(--gold-2); text-decoration: underline; font-weight: 500;";
      b.append(docLink);
    }
  }

  // Text content
  const isGenericPlaceholder =
    m.media_type &&
    (m.content === `[${m.media_type.toUpperCase()}]` ||
      m.content === "🎤 Voice message" ||
      m.content === "🎵 Audio" ||
      m.content === "🎥 Video" ||
      m.content === "🎨 Sticker");

  if (m.content && !isGenericPlaceholder) {
    const textNode = el("div", "msg-text", m.content);
    textNode.style.cssText = "word-break: break-word;";
    b.append(textNode);
  }

  // Message Reactions Badge
  let reactionList = [];
  if (m.reactions) {
    try {
      reactionList = typeof m.reactions === "string" ? JSON.parse(m.reactions) : m.reactions;
    } catch {}
  }
  if (Array.isArray(reactionList) && reactionList.length > 0) {
    const badge = el("div", "msg-reactions-badge");
    reactionList.forEach((r) => {
      const who = r.fromMe ? "You" : (r.sender || "");
      const pill = el("span", "msg-reaction-pill", `${r.emoji} ${who}`.trim());
      badge.append(pill);
    });
    b.append(badge);
  }

  let sender = "Them";
  if (isMe) {
    if (m.source === "whatsapp-device") {
      sender = `${overview?.settings?.ownerName || "You"} (Phone 📱)`;
    } else if (m.source === "dashboard-send") {
      sender = `${overview?.settings?.ownerName || "You"} (Dashboard 💻)`;
    } else {
      sender = "Lady Jane 👑";
    }
  } else {
    const ownerName = (overview?.settings?.ownerName || "").toLowerCase().trim();
    const ownerEmail = (overview?.gateway?.me?.name || "").toLowerCase().trim();
    const isBad = (s) => {
      if (!s) return true;
      const v = s.toLowerCase().trim();
      return v.includes("@gmail") || v.includes("@yahoo") || (ownerName && v === ownerName) || (ownerEmail && v === ownerEmail);
    };

    if (m.sender_name && !isBad(m.sender_name)) {
      sender = m.sender && !m.sender_name.includes(m.sender) ? `${m.sender_name} (+${m.sender})` : m.sender_name;
    } else if (m.sender) {
      sender = `+${m.sender}`;
    } else {
      sender = "Them";
    }
  }
  const meta = [sender, m.created_at ? fmtTime(m.created_at) : ""];
  if (m.neurons) meta.push(`${m.neurons.toFixed(1)} neurons`);

  const metaBox = el("div", "meta-box");
  metaBox.style.cssText = "display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-top: 4px;";
  metaBox.append(el("span", "meta", meta.filter(Boolean).join(" · ")));

  // Message Edit Tag & Edit History Modal Trigger
  let editHistoryList = [];
  if (m.edit_history) {
    try {
      editHistoryList = typeof m.edit_history === "string" ? JSON.parse(m.edit_history) : m.edit_history;
    } catch {}
  }
  if (m.edited_at || (Array.isArray(editHistoryList) && editHistoryList.length > 0)) {
    const editedTag = el("button", "msg-edited-badge", "✏️ Edited");
    editedTag.type = "button";
    editedTag.title = "View edit history (previous versions)";
    editedTag.onclick = (e) => {
      e.stopPropagation();
      showEditHistoryModal(m, editHistoryList);
    };
    metaBox.append(editedTag);
  }

  b.append(metaBox);
  return b;
}

function showEditHistoryModal(m, editHistory) {
  const modal = $("#edit-history-modal");
  const list = $("#edit-history-list");
  if (!modal || !list) return;

  list.replaceChildren();

  const sub = el("div", "edit-history-sub", `Edit history for message from ${m.sender_name || (m.role === "assistant" ? "You" : "Contact")}`);
  list.append(sub);

  // Past versions
  if (Array.isArray(editHistory) && editHistory.length > 0) {
    editHistory.forEach((h, idx) => {
      const card = el("div", "edit-history-item");
      const header = el("div", "edit-history-item-header");
      const tag = el("span", "badge-old", idx === 0 ? "Original Message" : `Version ${idx}`);
      const time = el("span", "edit-time", fmtTime(h.edited_at));
      header.append(tag, time);
      const text = el("div", "edit-history-text", h.text);
      card.append(header, text);
      list.append(card);
    });
  }

  // Current version
  const currentCard = el("div", "edit-history-item current");
  const curHeader = el("div", "edit-history-item-header");
  const curTag = el("span", "badge-current", "Current Message (Latest)");
  const curTime = el("span", "edit-time", m.edited_at ? fmtTime(m.edited_at) : fmtTime(m.created_at));
  curHeader.append(curTag, curTime);
  const curText = el("div", "edit-history-text", m.content);
  currentCard.append(curHeader, curText);
  list.append(currentCard);

  modal.classList.remove("hidden");
}

$("#close-edit-modal")?.addEventListener("click", () => {
  $("#edit-history-modal")?.classList.add("hidden");
});
$("#edit-history-modal")?.addEventListener("click", (e) => {
  if (e.target.id === "edit-history-modal") {
    $("#edit-history-modal").classList.add("hidden");
  }
});

async function loadDashboardChat() {
  const { messages } = await api("GET", "/api/messages?chat=dashboard");
  const log = $("#chat-log");
  log.replaceChildren(...messages.map(bubble));
  if (!messages.length) log.append(el("div", "msg assistant", "Good day! I am Lady Jane. Write to me here to test how I'll answer on WhatsApp. 👑"));
  log.scrollTop = log.scrollHeight;
  $("#chat-input").focus();
}

$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  const log = $("#chat-log");
  log.append(bubble({ role: "user", content: text, sender_name: "You", created_at: Date.now() }));
  const typing = el("div", "msg assistant typing", "Lady Jane is writing…");
  log.append(typing);
  log.scrollTop = log.scrollHeight;
  try {
    const r = await api("POST", "/api/chat", { text });
    typing.replaceWith(bubble({ role: "assistant", content: r.reply, created_at: Date.now(), neurons: r.neurons }));
  } catch (err) {
    typing.replaceWith(el("div", "msg assistant", `⚠️ ${err.message}`));
  }
  log.scrollTop = log.scrollHeight;
});

$("#chat-reset").addEventListener("click", async () => {
  await api("DELETE", "/api/messages?chat=dashboard");
  loadDashboardChat();
});

// ─── Conversations ───────────────────────────────────────────────────────────

function formatChatMeta(c) {
  if (c.chat_id === "dashboard") {
    return {
      titleHtml: "Dashboard 👑",
      sub: "AI test sandbox",
      headerHtml: "Dashboard 👑",
      subHeaderHtml: "Test Lady Jane's AI personality directly in this sandbox",
      primaryName: "Dashboard",
      phone: "",
      whatsappId: "dashboard",
    };
  }

  const ownerName = (overview?.settings?.ownerName || "").toLowerCase().trim();
  const ownerEmail = (overview?.gateway?.me?.name || "").toLowerCase().trim();

  const isInvalid = (val) => {
    if (!val) return true;
    const v = val.toLowerCase().trim();
    if (v.includes("@gmail") || v.includes("@yahoo") || v.includes("@hotmail")) return true;
    if (ownerName && v === ownerName) return true;
    if (ownerEmail && v === ownerEmail) return true;
    return false;
  };

  const deviceName = !isInvalid(c.name) ? c.name.trim() : null;
  const whatsappName = !isInvalid(c.notify_name) ? c.notify_name.trim() : null;
  const phone = c.phone || (!c.is_group && c.chat_id.includes("@s.whatsapp.net") ? c.chat_id.split("@")[0] : "");
  const formattedPhone = phone ? (phone.startsWith("+") ? phone : `+${phone}`) : "";
  const whatsappId = c.chat_id;

  if (c.is_group) {
    const title = `👥 ${c.name || "WhatsApp Group"}`;
    return {
      titleHtml: title,
      sub: `${c.message_count} messages · ${fmtTime(c.last_at)}`,
      headerHtml: title,
      subHeaderHtml: `Group conversation • ID: ${whatsappId}`,
      primaryName: c.name || "WhatsApp Group",
      phone: "",
      whatsappId,
    };
  }

  // 1-on-1 Contact chat:
  // Shows: name set in other device, whatsapp username, number, whatsapp unique id
  let titleHtml = "";
  let headerHtml = "";

  if (deviceName && whatsappName && deviceName.toLowerCase() !== whatsappName.toLowerCase()) {
    titleHtml = `${deviceName} <span style="font-size: 13px; font-weight: normal; opacity: 0.82;">(~${whatsappName})</span>`;
    headerHtml = `${deviceName} <span style="font-size: 14px; font-weight: normal; opacity: 0.85;">(~${whatsappName})</span>`;
  } else if (deviceName) {
    titleHtml = deviceName;
    headerHtml = deviceName;
  } else if (whatsappName) {
    titleHtml = `~${whatsappName}`;
    headerHtml = `~${whatsappName}`;
  } else {
    titleHtml = formattedPhone || whatsappId;
    headerHtml = formattedPhone || whatsappId;
  }

  const subLine = [
    formattedPhone && titleHtml !== formattedPhone ? formattedPhone : "",
    `${c.message_count} messages`,
    fmtTime(c.last_at),
  ].filter(Boolean).join(" · ");

  const subHeaderParts = [];
  if (formattedPhone) subHeaderParts.push(`<span>📞 ${formattedPhone}</span>`);
  if (whatsappName && !headerHtml.includes(whatsappName)) {
    subHeaderParts.push(`<span>WhatsApp: ~${whatsappName}</span>`);
  }
  subHeaderParts.push(`<span>WhatsApp ID: ${whatsappId}</span>`);
  const subHeaderHtml = subHeaderParts.join(` <span style="opacity: 0.4;">•</span> `);

  return {
    titleHtml,
    sub: subLine,
    headerHtml,
    subHeaderHtml,
    primaryName: deviceName || whatsappName || formattedPhone || "Contact",
    phone: formattedPhone,
    whatsappId,
  };
}

async function loadChats() {
  const { chats } = await api("GET", "/api/chats");
  const list = $("#chat-list");
  if (!chats.length) {
    list.replaceChildren(el("p", "muted", "No conversations yet. Once Lady Jane answers someone on WhatsApp, it appears here."));
    return;
  }
  list.replaceChildren(
    ...chats.map((c) => {
      const item = el("div", `chat-item${currentChat?.chat_id === c.chat_id ? " active" : ""}`);
      const meta = formatChatMeta(c);
      const nameEl = el("div", "name");
      nameEl.innerHTML = `${meta.titleHtml}${c.muted ? " 🔇" : ""}`;
      const subEl = el("div", "sub", meta.sub);
      item.append(nameEl, subEl);
      item.addEventListener("click", () => openChat(c));
      return item;
    }),
  );
}

async function openChat(c) {
  currentChat = c;
  const meta = formatChatMeta(c);
  $("#conv-title").innerHTML = meta.headerHtml;
  const subEl = $("#conv-sub");
  if (subEl) {
    subEl.innerHTML = meta.subHeaderHtml;
  }
  $("#conv-clear").classList.remove("hidden");
  $("#conv-mute").classList.toggle("hidden", c.chat_id === "dashboard");
  $("#conv-mute").textContent = c.muted ? "Unmute" : "Mute";

  const toggleBtn = $("#conv-instant-toggle");
  if (toggleBtn) {
    toggleBtn.classList.remove("hidden");
    const isPaused = Boolean(overview?.settings?.instantReplyPaused);
    toggleBtn.textContent = isPaused ? "▶ Turn ON Instant Reply" : "⏸ Turn OFF Instant Reply";
    toggleBtn.style.color = isPaused ? "var(--green)" : "#facc15";
    toggleBtn.onclick = async () => {
      await api("PUT", "/api/settings", { instantReplyPaused: !isPaused });
      await refreshOverview();
      openChat(c);
    };
  }

  const { messages } = await api("GET", `/api/messages?chat=${encodeURIComponent(c.chat_id)}`);
  const log = $("#conv-log");
  log.replaceChildren(...messages.map(bubble));
  log.scrollTop = log.scrollHeight;

  const form = $("#conv-send-form");
  const input = $("#conv-send-input");
  if (form && input) {
    if (c.chat_id === "dashboard") {
      form.classList.add("hidden");
    } else {
      form.classList.remove("hidden");
      input.placeholder = `Write a message to ${meta.primaryName}…`;
      input.focus();
    }
  }

  loadChats();
}

$("#conv-send-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentChat) return;
  const input = $("#conv-send-input");
  const btn = $("#conv-send-btn");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  if (btn) btn.disabled = true;

  // Optimistically append message to log
  const log = $("#conv-log");
  const b = bubble({
    role: "assistant",
    source: "dashboard-send",
    sender_name: overview?.settings?.ownerName || "You (Dashboard)",
    content: text,
    created_at: Date.now(),
  });
  log.append(b);
  log.scrollTop = log.scrollHeight;

  try {
    await api("POST", "/api/messages/send", { chat: currentChat.chat_id, text });
    loadChats();
  } catch (err) {
    alert("Failed to send direct WhatsApp message: " + err.message);
  } finally {
    if (btn) btn.disabled = false;
    input.focus();
  }
});

$("#conv-clear").addEventListener("click", async () => {
  if (!currentChat || !confirm("Delete Lady Jane's memory of this conversation?")) return;
  await api("DELETE", `/api/messages?chat=${encodeURIComponent(currentChat.chat_id)}`);
  openChat(currentChat);
});

$("#conv-mute").addEventListener("click", async () => {
  if (!currentChat) return;
  currentChat.muted = currentChat.muted ? 0 : 1;
  await api("PATCH", "/api/chats", { chat: currentChat.chat_id, muted: !!currentChat.muted });
  openChat(currentChat);
});

// ─── Rule Book ────────────────────────────────────────────────────────────────

let rules = [];

async function loadRules() {
  const data = await api("GET", "/api/rules");
  rules = data.rules || [];
  renderRules();
}

function renderRules() {
  const list = $("#rules-list");
  if (!rules.length) {
    list.replaceChildren(el("p", "muted", "No custom rules yet. Click '+ Add New Rule' to create an instant keyword reply or an AI guideline."));
    return;
  }
  list.replaceChildren(...rules.map((r) => {
    const card = el("div", `rule-card${r.enabled ? "" : " disabled"}`);

    const head = el("div", "rule-card-header");
    const badges = el("div", "rule-badges");
    if (r.type === "instant") {
      badges.append(el("span", "badge instant", "⚡ Instant Reply (0 Neurons)"));
    } else {
      badges.append(el("span", "badge guideline", "🧠 AI Guideline"));
    }

    const controls = el("div", "rule-controls");
    const toggle = el("label", "switch");
    const chk = el("input");
    chk.type = "checkbox";
    chk.checked = !!r.enabled;
    chk.addEventListener("change", async () => {
      await api("PATCH", "/api/rules", { id: r.id, enabled: chk.checked ? 1 : 0 });
      r.enabled = chk.checked ? 1 : 0;
      card.classList.toggle("disabled", !r.enabled);
    });
    toggle.append(chk, el("span", "small-text", r.enabled ? "Active" : "Paused"));

    const del = el("button", "danger small", "Delete");
    del.addEventListener("click", async () => {
      if (!confirm("Delete this rule?")) return;
      await api("DELETE", `/api/rules?id=${encodeURIComponent(r.id)}`);
      rules = rules.filter((x) => x.id !== r.id);
      renderRules();
    });

    controls.append(toggle, del);
    head.append(badges, controls);

    const triggers = el("div", "rule-triggers-preview");
    if (r.type === "instant") {
      triggers.textContent = `🎯 Trigger keywords: "${r.triggers}"`;
    } else {
      triggers.textContent = `📌 Topic / Label: "${r.triggers}"`;
    }

    const resp = el("div", "rule-response-preview", r.response);

    card.append(head, triggers, resp);
    return card;
  }));
}

$("#add-rule-toggle").addEventListener("click", () => {
  $("#new-rule-form").classList.toggle("hidden");
  $("#rule-triggers").focus();
});

$("#cancel-rule-btn").addEventListener("click", () => {
  $("#new-rule-form").classList.add("hidden");
  $("#rule-error").textContent = "";
});

$("#rule-type").addEventListener("change", (e) => {
  const isInstant = e.target.value === "instant";
  $("#rule-trigger-label").innerHTML = isInstant
    ? 'Trigger Keywords <span class="muted">(comma-separated, e.g. price, cost, দাম, রেট)</span>'
    : 'Topic / Guideline Label <span class="muted">(e.g. Tone, Pricing, Discounts, Policies)</span>';
  $("#rule-response-label").innerHTML = isInstant
    ? 'Instant Reply Message <span class="muted">(Sent word-for-word, 0 Neurons)</span>'
    : 'AI Instruction <span class="muted">(How Lady Jane should behave)</span>';
});

$("#new-rule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const type = $("#rule-type").value;
  const triggers = $("#rule-triggers").value.trim();
  const response = $("#rule-response").value.trim();
  $("#rule-error").textContent = "";

  if (!triggers || !response) {
    $("#rule-error").textContent = "Please fill in both fields.";
    return;
  }

  try {
    const res = await api("POST", "/api/rules", { type, triggers, response, enabled: true });
    rules.unshift(res.rule);
    renderRules();
    form.reset();
    form.classList.add("hidden");
  } catch (err) {
    $("#rule-error").textContent = err.message;
  }
});

// ─── Settings ────────────────────────────────────────────────────────────────

async function fillSettings() {
  if (!overview) await refreshOverview();
  const { settings: s, models } = overview;
  const f = $("#settings-form");
  $("#model-select").replaceChildren(...models.map((m) => Object.assign(el("option", null, m.label), { value: m.id })));
  f.enabled.checked = s.enabled;
  if (f.instantReplyPaused) f.instantReplyPaused.checked = Boolean(s.instantReplyPaused);
  f.ownerName.value = s.ownerName;
  f.replyMode.value = s.replyMode;
  f.allowlist.value = s.allowlist.join("\n");
  f.groupsEnabled.checked = s.groupsEnabled;
  f.triggerWords.value = s.triggerWords.join(", ");
  f.model.value = s.model;
  f.historyLimit.value = s.historyLimit;
  f.maxReplyTokens.value = s.maxReplyTokens;
  f.temperature.value = s.temperature;
  f.extraInstructions.value = s.extraInstructions;
}

$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.replyMode.value === "everyone" && overview.settings.replyMode !== "everyone" &&
      !confirm("Lady Jane will answer EVERYONE who messages you privately. Are you sure?")) return;
  const btn = f.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const { settings } = await api("PUT", "/api/settings", {
      enabled: f.enabled.checked,
      instantReplyPaused: f.instantReplyPaused ? f.instantReplyPaused.checked : false,
      ownerName: f.ownerName.value,
      replyMode: f.replyMode.value,
      allowlist: f.allowlist.value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean),
      groupsEnabled: f.groupsEnabled.checked,
      triggerWords: f.triggerWords.value.split(",").map((x) => x.trim()).filter(Boolean),
      model: f.model.value,
      historyLimit: Number(f.historyLimit.value),
      maxReplyTokens: Number(f.maxReplyTokens.value),
      temperature: Number(f.temperature.value),
      extraInstructions: f.extraInstructions.value,
    });
    overview.settings = settings;
    fillSettings();
    $("#settings-saved").textContent = "Saved ✓";
    setTimeout(() => ($("#settings-saved").textContent = ""), 2500);
  } catch (err) {
    $("#settings-saved").textContent = `⚠️ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("#btn-clean-media")?.addEventListener("click", async () => {
  const btn = $("#btn-clean-media");
  const status = $("#clean-media-status");
  btn.disabled = true;
  status.textContent = "Checking files older than 10 days…";
  try {
    const res = await api("POST", "/api/media/cleanup?days=10");
    status.textContent = `Cleaned ${res.deletedCount || 0} expired media file(s).`;
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ─── Boot ────────────────────────────────────────────────────────────────────

if (password) enterApp().catch(() => signOut());
else signOut();
