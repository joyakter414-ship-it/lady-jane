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
    if (!document.hidden && !$("#tab-home").classList.contains("hidden")) refreshOverview().catch(() => {});
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

  let [dot, label] = STATES[gateway.state] || ["off", gateway.state];
  if (!isOnline && gateway.state !== "never_connected") {
    [dot, label] = ["off", "Gateway offline (runner sleeping)"];
  }
  const status = $("#wa-status");
  status.replaceChildren(el("span", `dot ${dot}`), el("span", null, label));
  if (isOpen && gateway.me?.phone) {
    status.append(el("span", "muted", ` as +${gateway.me.phone}${gateway.me.name ? ` (${gateway.me.name})` : ""}`));
  } else if (!isOnline && gateway.me?.phone) {
    status.append(el("span", "muted", ` (last linked: +${gateway.me.phone}${gateway.me.name ? ` - ${gateway.me.name}` : ""})`));
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
  $("#quick-mode").textContent = { self: "Only me", allowlist: "Me + chosen numbers", everyone: "Everyone" }[settings.replyMode];
  $("#quick-model").textContent = (models.find((m) => m.id === settings.model)?.label || settings.model).split(" — ")[0];
}

$("#quick-enabled").addEventListener("change", async (e) => {
  await api("PUT", "/api/settings", { enabled: e.target.checked });
  refreshOverview();
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
  const b = el("div", `msg ${m.role}`, m.content);
  const meta = [m.role === "user" ? m.sender_name || "Them" : "Lady Jane", m.created_at ? fmtTime(m.created_at) : ""];
  if (m.neurons) meta.push(`${m.neurons.toFixed(1)} neurons`);
  b.append(el("span", "meta", meta.filter(Boolean).join(" · ")));
  return b;
}

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
      const name = c.name || c.chat_id.split("@")[0];
      item.append(
        el("div", "name", `${c.is_group ? "👥 " : ""}${name}${c.muted ? " 🔇" : ""}`),
        el("div", "sub", `${c.message_count} messages · ${fmtTime(c.last_at)}`),
      );
      item.addEventListener("click", () => openChat(c));
      return item;
    }),
  );
}

async function openChat(c) {
  currentChat = c;
  $("#conv-title").textContent = c.name || c.chat_id;
  $("#conv-clear").classList.remove("hidden");
  $("#conv-mute").classList.toggle("hidden", c.chat_id === "dashboard");
  $("#conv-mute").textContent = c.muted ? "Unmute" : "Mute";
  const { messages } = await api("GET", `/api/messages?chat=${encodeURIComponent(c.chat_id)}`);
  const log = $("#conv-log");
  log.replaceChildren(...messages.map(bubble));
  log.scrollTop = log.scrollHeight;
  loadChats();
}

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

// ─── Boot ────────────────────────────────────────────────────────────────────

if (password) enterApp().catch(() => signOut());
else signOut();
