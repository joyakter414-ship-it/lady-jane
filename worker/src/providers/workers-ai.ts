import type { Provider } from "./index";

interface WorkersAiTextResult {
  response?: string | null;
  choices?: { message?: { content?: string | null }; text?: string | null }[];
  usage?: { neurons?: number };
}

/** Cloudflare Workers AI — billed in Neurons (10,000 free per day). */
export const workersAi: Provider = {
  id: "workers-ai",
  async generate(env, opts) {
    // The AI binding's types are keyed by model name; we pick models at runtime.
    const run = env.AI.run.bind(env.AI) as unknown as (model: string, input: unknown) => Promise<WorkersAiTextResult>;
    const res = await run(opts.model, {
      messages: opts.messages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
    });
    const text = (res.response ?? res.choices?.[0]?.message?.content ?? res.choices?.[0]?.text ?? "").trim();
    if (!text) throw new Error(`Empty response from ${opts.model}`);
    return { text, provider: "workers-ai", model: opts.model, neurons: res.usage?.neurons };
  },
};
