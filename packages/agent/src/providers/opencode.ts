import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { join } from "node:path";
import type { KeyLookup, KeySource } from "../keys.ts";
import { readKey } from "../keys.ts";

/** The pi-ai provider id; it matches AgentModelRef.provider. */
export const OPENCODE_PROVIDER = "opencode-go";
/** The model used when OpenCodeOptions.model is absent. */
export const OPENCODE_DEFAULT_MODEL = "deepseek-v4.1-flash";

/** What opencodeGo needs. */
export interface OpenCodeOptions {
  /** The key, written to OPENCODE_API_KEY for pi-ai's provider to read. */
  readonly apiKey: string;
  /** The model id; defaults to OPENCODE_DEFAULT_MODEL. */
  readonly model?: string | undefined;
}

/** One provider, its model id, and the AgentModelRef that selects it. */
export interface OpenCodeModel {
  readonly provider: ReturnType<typeof opencodeGoProvider>;
  /** The resolved model id, after the default. */
  readonly model: string;
  /** Pass this to AgentOptions.model. */
  readonly ref: { readonly provider: string; readonly modelId: string };
}

/**
 * Build the OpenCode Go provider and the model reference the agent runs on.
 *
 * @param options - The API key and an optional model id.
 * @returns The provider, the resolved model id, and the ref for openAgent.
 *
 * @remarks
 * OpenCode Go ships as a pi-ai provider that reads OPENCODE_API_KEY from the
 * environment, so the key is set here, at the composition root, and nowhere else:
 * the provider offers no argument for it. That write is process-global, so one
 * process cannot run two agents with different OpenCode keys.
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

/**
 * Where an OpenCode key may live: the environment, then our own config files.
 *
 * @param home - The user's home directory; `~/.config/hns/opencode-go.key` is tried
 * before `~/.config/hns/opencode.key`.
 * @param cwd - The checkout directory; `.work/opencode.key` is the last fallback.
 * @returns The lookup readKey consumes; the environment wins over every file.
 */
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

/**
 * Read the OpenCode key in opencodeKeyLookup's order.
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
export function readOpenCodeKey(home: string, cwd: string, source: KeySource): string | undefined {
  return readKey(opencodeKeyLookup(home, cwd), source);
}
