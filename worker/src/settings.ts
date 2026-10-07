import type { AppEnv } from "./env";
import { kvGet, kvSet } from "./db";

export type ReplyMode = "self" | "allowlist" | "everyone";

export interface Settings {
  /** Master switch. When off, Lady Jane stays silent on WhatsApp (dashboard chat still works). */
  enabled: boolean;
  /** AI provider id — only "workers-ai" for now; Claude etc. plug in later via providers/. */
  provider: string;
  model: string;
  /**
   * Who Lady Jane answers in private chats:
   * - self:      only your own "Message yourself" chat (safest, default)
   * - allowlist: self chat + the phone numbers in `allowlist`
   * - everyone:  every private chat
   */
  replyMode: ReplyMode;
  /** Phone numbers in international format, digits only (e.g. 8801712345678). */
  allowlist: string[];
  /** Answer in groups — only when mentioned, replied to, or a trigger word appears. */
  groupsEnabled: boolean;
  triggerWords: string[];
  historyLimit: number;
  maxReplyTokens: number;
  temperature: number;
  ownerName: string;
  extraInstructions: string;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  provider: "workers-ai",
  model: "@cf/meta/llama-4-scout-17b-16e-instruct",
  replyMode: "self",
  allowlist: [],
  groupsEnabled: false,
  triggerWords: ["jane", "lady jane", "জেন"],
  historyLimit: 12,
  maxReplyTokens: 400,
  temperature: 0.7,
  ownerName: "",
  extraInstructions: "",
};

/** Models offered in the dashboard. All tested with the chat `messages` format. */
export const MODELS = [
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B — fast, cheap, good Bangla (recommended)" },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B — smarter, ~3–5× more Neurons" },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1 24B — balanced" },
  { id: "@cf/meta/llama-3.1-8b-instruct-fp8", label: "Llama 3.1 8B — cheapest, simplest" },
];

const KEY = "settings";

export async function getSettings(env: AppEnv): Promise<Settings> {
  const stored = await kvGet<Partial<Settings>>(env, KEY);
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function saveSettings(env: AppEnv, patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings(env);
  const next = sanitize({ ...current, ...patch });
  await kvSet(env, KEY, next);
  return next;
}

function sanitize(s: Settings): Settings {
  const clamp = (n: unknown, lo: number, hi: number, d: number) => {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  };
  return {
    enabled: Boolean(s.enabled),
    provider: s.provider === "workers-ai" ? s.provider : "workers-ai",
    model: MODELS.some((m) => m.id === s.model) ? s.model : DEFAULT_SETTINGS.model,
    replyMode: (["self", "allowlist", "everyone"] as const).includes(s.replyMode) ? s.replyMode : "self",
    allowlist: [...new Set((Array.isArray(s.allowlist) ? s.allowlist : []).map((p) => String(p).replace(/\D/g, "")).filter((p) => p.length >= 6))],
    groupsEnabled: Boolean(s.groupsEnabled),
    triggerWords: (Array.isArray(s.triggerWords) ? s.triggerWords : []).map((w) => String(w).trim().toLowerCase()).filter(Boolean).slice(0, 20),
    historyLimit: Math.round(clamp(s.historyLimit, 0, 40, DEFAULT_SETTINGS.historyLimit)),
    maxReplyTokens: Math.round(clamp(s.maxReplyTokens, 50, 2000, DEFAULT_SETTINGS.maxReplyTokens)),
    temperature: clamp(s.temperature, 0, 1.5, DEFAULT_SETTINGS.temperature),
    ownerName: String(s.ownerName ?? "").slice(0, 80),
    extraInstructions: String(s.extraInstructions ?? "").slice(0, 4000),
  };
}
