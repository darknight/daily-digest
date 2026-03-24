import { type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

const DEFAULT_MODEL = "anthropic:claude-sonnet-4-6";

const PROVIDER_ENV_KEYS: Record<string, string> = {
  zhipu: "ZHIPU_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

export function resolveModel(modelStr?: string): LanguageModel {
  const spec = modelStr || process.env.AI_MODEL || DEFAULT_MODEL;
  const colonIdx = spec.indexOf(":");
  if (colonIdx === -1) {
    throw new Error(
      `Invalid model format: "${spec}". Use provider:model, e.g. anthropic:claude-haiku-4-5-20251001`,
    );
  }

  const provider = spec.slice(0, colonIdx);
  const modelName = spec.slice(colonIdx + 1);
  const envKey = PROVIDER_ENV_KEYS[provider];

  if (envKey && !process.env[envKey]) {
    throw new Error(`Missing ${envKey} environment variable for model: ${spec}`);
  }

  switch (provider) {
    case "zhipu":
      return createOpenAI({
        baseURL: process.env.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
        apiKey: process.env.ZHIPU_API_KEY,
      }).chat(modelName);
    case "openai":
      return createOpenAI().chat(modelName);
    case "anthropic":
      return createAnthropic()(modelName);
    case "google":
      return createGoogleGenerativeAI()(modelName);
    default:
      throw new Error(
        `Unsupported provider: "${provider}". Supported: zhipu, openai, anthropic, google`,
      );
  }
}

export function getModelSpec(): string {
  return process.env.AI_MODEL || DEFAULT_MODEL;
}

// ── Utilities ───────────────────────────────────────────

export async function withConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
