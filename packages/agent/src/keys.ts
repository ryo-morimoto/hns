import { existsSync, readFileSync } from "node:fs";

/** Where a key may come from: the environment first, then files in order. */
export interface KeyLookup {
  readonly env: string;
  readonly files: readonly string[];
}

export interface KeySource {
  readonly env: (name: string) => string | undefined;
  readonly readFile: (path: string) => string | undefined;
}

/** The first non-empty value. Empty strings and blank files are not keys. */
export function readKey(lookup: KeyLookup, source: KeySource): string | undefined {
  const fromEnv = source.env(lookup.env);
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  for (const path of lookup.files) {
    const text = source.readFile(path);
    if (text !== undefined && text.trim() !== "") return text.trim();
  }
  return undefined;
}

/** The real file system, for the composition root. */
export const fileKeySource: KeySource = {
  env: (name) => process.env[name],
  readFile: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
};

/** A key source over a fixed environment and file map, for tests. */
export function fixedKeySource(
  env: Readonly<Record<string, string | undefined>>,
  files: Readonly<Record<string, string>>,
): KeySource {
  return {
    env: (name) => env[name],
    readFile: (path) => files[path],
  };
}
