import type { AppEnv } from "../env";
import { workersAi } from "./workers-ai";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GenerateOptions {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
}

export interface GenerateResult {
  text: string;
  provider: string;
  model: string;
  /** Workers AI Neurons consumed, when the provider reports it. */
  neurons?: number;
}

/**
 * An AI backend. To add Claude, OpenAI, etc. later: create a file in this
 * folder implementing `Provider`, register it below, and allow its id in
 * settings.ts. Nothing else in the app needs to change.
 */
export interface Provider {
  id: string;
  generate(env: AppEnv, opts: GenerateOptions): Promise<GenerateResult>;
}

const PROVIDERS: Record<string, Provider> = {
  [workersAi.id]: workersAi,
};

export function getProvider(id: string): Provider {
  return PROVIDERS[id] ?? workersAi;
}
