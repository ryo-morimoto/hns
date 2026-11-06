import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { join } from "node:path";
import type { KeyLookup, KeySource } from "../keys.ts";
import { readKey } from "../keys.ts";

export const OPENCODE_PROVIDER = "opencode-go";
export const OPENCODE_DEFAULT_MODEL = "deepseek-v4.1-flash";

export interface OpenCodeOptions {
  readonly apiKey: string;
  readonly model?: string | undefined;
}

export interface OpenCodeModel {
  readonly provider: ReturnType<typeof opencodeGoProvider>;
  readonly model: string;
  readonly ref: { readonly provider: string; readonly modelId: string };
}

/**
 * OpenCode Go ships as a pi-ai provider that reads OPENCODE_API_KEY from the
 * environment, so the key is set here, at the composition root, and nowhere else.
 */
export function opencodeGo(options: OpenCodeOptions): OpenCodeModel {
  const model = options.model ?? OPENCODE_DEFAULT_MODEL;
  process.env.OPENCODE_API_KEY = options.apiKey;
  return {
    provider: opencodeGoProvider(),
    model,
    ref: { provider: OPENCODE_PROVIDER, modelId: model },
  };
}

/** Where an OpenCode key may live: the environment, then our own config files. */
export function opencodeKeyLookup(home: string, cwd: string): KeyLookup {
  return {
    env: "OPENCODE_API_KEY",
    files: [
      join(home, ".config", "hns", "opencode-go.key"),
      join(home, ".config", "hns", "opencode.key"),
      join(cwd, ".work", "opencode.key"),
    ],
  };
}

export function readOpenCodeKey(home: string, cwd: string, source: KeySource): string | undefined {
  return readKey(opencodeKeyLookup(home, cwd), source);
}
