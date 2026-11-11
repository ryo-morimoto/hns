import { existsSync, readFileSync } from "node:fs";

/** Where a key may come from: the environment first, then files in order. */
export interface KeyLookup {
  /** The environment variable name, checked before any file. */
  readonly env: string;
  /** File paths, tried in order after the environment. */
  readonly files: readonly string[];
}

/**
 * The lookups readKey needs, so a test can supply an environment and files
 * without the disk.
 */
export interface KeySource {
  /** Reads an environment variable; undefined when it is unset. */
  readonly env: (name: string) => string | undefined;
  /** Reads a file's text; undefined when it does not exist. */
  readonly readFile: (path: string) => string | undefined;
}

/**
 * The first non-empty value. Empty strings and blank files are not keys.
 *
 * @param lookup - The environment variable name and the files to try, in order.
 * @param source - Where values come from; the real environment and files, or a fake.
 * @returns The trimmed key, or undefined when no source holds one.
 *
 * @remarks
 * The environment wins over every file even when the files are listed first. A
 * whitespace-only value is rejected at each step, so a blank env var falls through
 * to the files instead of masking a real key.
 *
 * @example
 * ```ts @import.meta.vitest
 * const source = fixedKeySource({ KEY: " env-key ", BLANK: "  " }, { "/file": "file-key" });
 * expect(readKey({ env: "KEY", files: ["/file"] }, source)).toBe("env-key");
 * expect(readKey({ env: "UNSET", files: ["/file"] }, source)).toBe("file-key");
 * expect(readKey({ env: "BLANK", files: ["/file"] }, source)).toBe("file-key");
 * const blank = fixedKeySource({}, { "/blank": " " });
 * expect(readKey({ env: "UNSET", files: ["/blank"] }, blank)).toBeUndefined();
 * ```
 */
export function readKey(lookup: KeyLookup, source: KeySource): string | undefined {
  const fromEnv = source.env(lookup.env);
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  for (const path of lookup.files) {
    const text = source.readFile(path);
    if (text !== undefined && text.trim() !== "") return text.trim();
  }
  return undefined;
}

/**
 * The real file system, for the composition root.
 *
 * @remarks
 * A missing file reads as undefined, but a file that exists and cannot be read
 * throws: a permission error must not look like an absent key.
 */
export const fileKeySource: KeySource = {
  env: (name) => process.env[name],
  readFile: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
};

/**
 * A key source over a fixed environment and file map, for tests.
 *
 * @param env - Variable values; an absent name reads as undefined.
 * @param files - File contents by path; an absent path reads as undefined.
 * @returns A KeySource that never touches the real environment or disk.
 */
export function fixedKeySource(
  env: Readonly<Record<string, string | undefined>>,
  files: Readonly<Record<string, string>>,
): KeySource {
  return {
    env: (name) => env[name],
    readFile: (path) => files[path],
  };
}
