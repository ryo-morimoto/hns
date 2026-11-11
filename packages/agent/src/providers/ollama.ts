import { createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { join } from "node:path";
import type { KeyLookup, KeySource } from "../keys.ts";
import { readKey } from "../keys.ts";

/** The pi-ai provider id; it matches AgentModelRef.provider. */
export const OLLAMA_PROVIDER = "ollama-cloud";
/** The model used when OllamaOptions.model is absent. */
export const OLLAMA_DEFAULT_MODEL = "gpt-oss:120b";
/** Ollama Cloud speaks the OpenAI completions API at /v1, so no Ollama-specific protocol is involved. */
const OLLAMA_BASE_URL = "https://ollama.com/v1";

/** The provider object createProvider built; pi-ai resolves auth and streams through it. */
export type BuiltProvider = ReturnType<typeof createProvider>;

/** What ollamaCloud needs. */
export interface OllamaOptions {
  /** The key; "" leaves the provider unconfigured rather than sending an empty credential. */
  readonly apiKey: string;
  /** The model id; defaults to OLLAMA_DEFAULT_MODEL. */
  readonly model?: string | undefined;
  /** The OpenAI-compatible base URL; defaults to OLLAMA_BASE_URL. */
  readonly baseUrl?: string | undefined;
}

/** One provider, its model id, and the AgentModelRef that selects it. */
export interface BuiltModel {
  readonly provider: BuiltProvider;
  /** The resolved model id, after the default. */
  readonly model: string;
  /** Pass this to AgentOptions.model. */
  readonly ref: { readonly provider: string; readonly modelId: string };
}

/**
 * Build the Ollama Cloud provider and the model reference the agent runs on.
 *
 * @param options - The API key, and an optional model id and base URL.
 * @returns The provider, the resolved model id, and the ref for openAgent.
 *
 * @remarks
 * The model is registered under OLLAMA_PROVIDER at the same base URL as the
 * provider. The key is resolved lazily, so an empty one fails the first request
 * rather than this call.
 */
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

/**
 * Where an Ollama key may live: the environment, then our own config files.
 *
 * @param home - The user's home directory; `~/.config/hns/ollama.key` is tried first.
 * @param cwd - The checkout directory; `.work/ollama.key` is the last fallback.
 * @returns The lookup readKey consumes; the environment wins over both files.
 */
export function ollamaKeyLookup(home: string, cwd: string): KeyLookup {
  return {
    env: "OLLAMA_API_KEY",
    files: [join(home, ".config", "hns", "ollama.key"), join(cwd, ".work", "ollama.key")],
  };
}

/**
 * Read the Ollama key in ollamaKeyLookup's order.
 *
 * @param home - The user's home directory.
 * @param cwd - The checkout directory.
 * @param source - The environment and files to read.
 * @returns The trimmed key, or undefined when none is set.
 *
 * @remarks
 * A blank value at one step falls through to the next, so an empty environment
 * variable does not mask a key file.
 */
export function readOllamaKey(home: string, cwd: string, source: KeySource): string | undefined {
  return readKey(ollamaKeyLookup(home, cwd), source);
}
