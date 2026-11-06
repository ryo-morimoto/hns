import { createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { join } from "node:path";
import type { KeyLookup, KeySource } from "../keys.ts";
import { readKey } from "../keys.ts";

export const OLLAMA_PROVIDER = "ollama-cloud";
export const OLLAMA_DEFAULT_MODEL = "gpt-oss:120b";
const OLLAMA_BASE_URL = "https://ollama.com/v1";

/** Ollama Cloud speaks the OpenAI completions API at /v1. */
export type BuiltProvider = ReturnType<typeof createProvider>;

export interface OllamaOptions {
  readonly apiKey: string;
  readonly model?: string | undefined;
  readonly baseUrl?: string | undefined;
}

export interface BuiltModel {
  readonly provider: BuiltProvider;
  readonly model: string;
  readonly ref: { readonly provider: string; readonly modelId: string };
}

export function ollamaCloud(options: OllamaOptions): BuiltModel {
  const model = options.model ?? OLLAMA_DEFAULT_MODEL;
  const baseUrl = options.baseUrl ?? OLLAMA_BASE_URL;
  const apiKey = options.apiKey;
  const provider = createProvider({
    id: OLLAMA_PROVIDER,
    name: "Ollama Cloud",
    baseUrl,
    auth: {
      apiKey: {
        name: "Ollama Cloud API key",
        resolve: async () => (apiKey === "" ? undefined : { auth: { apiKey }, source: "key" }),
      },
    },
    models: [
      {
        id: model,
        name: model,
        api: "openai-completions",
        provider: OLLAMA_PROVIDER,
        baseUrl,
        input: ["text"],
        reasoning: false,
        contextWindow: 256000,
        maxTokens: 32768,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    api: openAICompletionsApi(),
  });
  return { provider, model, ref: { provider: OLLAMA_PROVIDER, modelId: model } };
}

/** Where an Ollama key may live: the environment, then our own config files. */
export function ollamaKeyLookup(home: string, cwd: string): KeyLookup {
  return {
    env: "OLLAMA_API_KEY",
    files: [join(home, ".config", "hns", "ollama.key"), join(cwd, ".work", "ollama.key")],
  };
}

export function readOllamaKey(home: string, cwd: string, source: KeySource): string | undefined {
  return readKey(ollamaKeyLookup(home, cwd), source);
}
