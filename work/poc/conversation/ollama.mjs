// Ollama Cloud through the OpenAI-compatible endpoint (/v1).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const OLLAMA_KEY_PATHS = [
  join(homedir(), ".config", "hns", "ollama.key"),
  join(process.cwd(), ".work", "ollama.key"),
];

export function readOllamaKey() {
  if (process.env.OLLAMA_API_KEY) return process.env.OLLAMA_API_KEY.trim();
  for (const path of OLLAMA_KEY_PATHS) {
    if (existsSync(path)) return readFileSync(path, "utf8").trim();
  }
  return undefined;
}

export function ollamaCloud({ apiKey = readOllamaKey(), model = "qwen3-coder:480b", baseUrl = "https://ollama.com/v1" } = {}) {
  const provider = createProvider({
    id: "ollama-cloud",
    name: "Ollama Cloud",
    baseUrl,
    auth: {
      apiKey: {
        name: "Ollama Cloud API key",
        resolve: async () => (apiKey ? { auth: { apiKey }, source: "key" } : undefined),
      },
    },
    models: [
      {
        id: model, name: model, api: "openai-completions", provider: "ollama-cloud", baseUrl,
        input: ["text"], reasoning: false, contextWindow: 256000, maxTokens: 32768,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    ],
    api: openAICompletionsApi(),
  });
  return { provider, model };
}
