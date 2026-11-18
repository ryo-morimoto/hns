import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { OFFICE_SHA256_PATTERN, officeArtifactFile, officeCachePath } from "@hns/core/office";
import type { OfficeCacheKey } from "@hns/core";

/**
 * The days a cache entry lives, from its last use (§4).
 *
 * @remarks
 * A preview is cheap to make again and expensive to keep: seven days is long enough that a
 * person reopening a document this week does not wait for the engine, and short enough that a
 * machine does not carry every document it has ever shown.
 */
export const OFFICE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The bytes every entry may take together, before the least recently used go (§4). */
export const OFFICE_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** The marker that says an entry was complete: written after the artifact it describes. */
const ENTRY_MARKER = "entry.json";

/**
 * What a job tells the cache about the artifact it just made.
 *
 * @remarks
 * The size and the use time are the cache's own (it measures the file and stamps the clock), so a
 * caller cannot claim an artifact is a different size from the one it handed over.
 */
export interface CacheEntryFacts {
  /** The artifact's sha256, `sha256:<hex>`. */
  readonly sha256: string;
  /** Pages in the PDF, when the operation makes one. */
  readonly pages?: number | undefined;
  /** Fonts the engine substituted; empty means every font was found. */
  readonly missingFonts: readonly string[];
  /** The engine that produced it. */
  readonly engine: { readonly id: string; readonly version: string };
}

/**
 * What one cache entry records beside its bytes.
 *
 * @remarks
 * The artifact's own metadata is here rather than derived from the file again: a hit answers in
 * milliseconds and must not re-hash a 50 MiB PDF to say what it is. `usedAt` is what the LRU
 * orders by, and `bytes` is the artifact's size, which is what the two-gigabyte total counts.
 */
export interface CacheEntryMetadata {
  /** When the entry was last used, epoch milliseconds; the LRU's order. */
  readonly usedAt: number;
  /** Bytes in the artifact file. */
  readonly bytes: number;
  /** The artifact's sha256, `sha256:<hex>`. */
  readonly sha256: string;
  /** Pages in the PDF, when the operation makes one. */
  readonly pages?: number | undefined;
  /** Fonts the engine substituted; empty means every font was found. */
  readonly missingFonts: readonly string[];
  /** The engine that produced it. */
  readonly engine: { readonly id: string; readonly version: string };
}

/** One entry the sweep found: what it is and how big. */
interface CacheEntry {
  readonly path: string;
  readonly directory: string;
  readonly metadataPath: string;
  readonly usedAt: number;
  readonly bytes: number;
  readonly files: number;
}

/**
 * The machine's office cache: one directory, one key per artifact (§4).
 *
 * @remarks
 * The path of an entry is `officeCachePath(key)` and nothing else: this class joins a root onto
 * what the contract derived, so a key with a `..` would be refused by the contract before it
 * reached a directory. An entry is written as a temporary directory beside its final name, then
 * renamed into place, and the marker is written last, so a reader never sees a half-written
 * entry and a crash leaves a temporary one the sweep removes (INV-O4).
 *
 * The cache is also the only thing `GET /artifact` reads. It is **not** under ROOT: a job's output
 * is a preview of the workspace, never part of it (INV-O3), and the route that serves it resolves
 * a key inside this directory rather than under the root.
 */
export class OfficeCache {
  readonly #root: string;
  readonly #ttlMs: number;
  readonly #maxBytes: number;
  readonly #now: () => number;

  constructor(options: {
    readonly root: string;
    readonly ttlMs?: number | undefined;
    readonly maxBytes?: number | undefined;
    readonly now?: (() => number) | undefined;
  }) {
    this.#root = options.root;
    this.#ttlMs = options.ttlMs ?? OFFICE_CACHE_TTL_MS;
    this.#maxBytes = options.maxBytes ?? OFFICE_CACHE_MAX_BYTES;
    this.#now = options.now ?? Date.now;
  }

  /** The directory every entry lives under. */
  get root(): string {
    return this.#root;
  }

  /** Where one key's artifact is. */
  path(key: OfficeCacheKey): string {
    return join(this.#root, officeCachePath(key));
  }

  /**
   * Answer a hit, or undefined when the key has no complete entry.
   *
   * @param key - The 5-tuple.
   * @returns The metadata and artifact path, with the entry's use time refreshed.
   *
   * @remarks
   * A hit is an entry whose marker parses and whose artifact exists: a directory without the
   * marker is a write that did not finish, and is replaced by the next job. Refreshing `usedAt`
   * is what makes eviction least-recently-used rather than oldest.
   */
  async lookup(
    key: OfficeCacheKey,
  ): Promise<{ readonly metadata: CacheEntryMetadata; readonly path: string } | undefined> {
    const artifact = this.path(key);
    const metadataPath = join(dirname(artifact), ENTRY_MARKER);
    const metadata = await this.#readMetadata(metadataPath);
    if (metadata === undefined) return undefined;
    const info = await stat(artifact).catch(() => undefined);
    if (info === undefined || !info.isFile() || info.size !== metadata.bytes) return undefined;
    const usedAt = this.#now();
    await this.#writeMetadata(metadataPath, { ...metadata, usedAt }).catch(() => undefined);
    return { metadata: { ...metadata, usedAt }, path: artifact };
  }

  /**
   * Write one entry, atomically, and prune what the write made over the bounds.
   *
   * @param key - The 5-tuple.
   * @param bytes - The artifact's bytes.
   * @param metadata - What the entry records beside them.
   * @returns The artifact's path.
   * @throws {Error} When the entry cannot be written; the temporary directory is removed first.
   *
   * @remarks
   * The bytes and the marker are written in a directory named `.<...>.tmp-<random>` beside the
   * entry, then renamed onto the entry's own name: a reader either sees the old entry or the new
   * one, never a mixture, and a failure leaves nothing at the entry's path (INV-O4).
   */
  async store(key: OfficeCacheKey, bytes: Uint8Array, facts: CacheEntryFacts): Promise<string> {
    const artifact = this.path(key);
    const directory = dirname(artifact);
    await mkdir(dirname(directory), { recursive: true });
    const staging = join(
      dirname(directory),
      "." + officeArtifactFile(key.operation) + "-" + key.paramsHash + ".tmp-" + randomUUID(),
    );
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      const file = join(staging, officeArtifactFile(key.operation));
      await writeFile(file, bytes);
      const entry: CacheEntryMetadata = {
        usedAt: this.#now(),
        bytes: bytes.byteLength,
        sha256: facts.sha256,
        missingFonts: facts.missingFonts,
        engine: facts.engine,
      };
      const metadata: CacheEntryMetadata =
        facts.pages === undefined ? entry : { ...entry, pages: facts.pages };
      await this.#writeMetadata(join(staging, ENTRY_MARKER), metadata);
      await rm(directory, { recursive: true, force: true });
      await rename(staging, directory);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return artifact;
  }

  /**
   * Remove entries that are past their time, or over the total size.
   *
   * @returns What was removed, and what could not be.
   *
   * @remarks
   * It runs at start (the previous process's expired entries) and after a write (the bound). The
   * order is time first, then least recently used until the total fits: an entry touched a minute
   * ago outlives one written last week that nobody has opened. A deletion that fails is reported
   * rather than thrown, because a cache that cannot clean itself must still serve; the next sweep
   * finds the same entry.
   */
  async sweep(): Promise<{ readonly removed: number; readonly failures: readonly string[] }> {
    const entries = await this.#scan();
    const now = this.#now();
    let removed = 0;
    const failures: string[] = [];
    const keep: CacheEntry[] = [];
    for (const entry of entries) {
      if (now - entry.usedAt > this.#ttlMs) {
        if (await this.#remove(entry)) removed += 1;
        else failures.push(entry.path);
      } else {
        keep.push(entry);
      }
    }
    let total = keep.reduce((sum, entry) => sum + entry.bytes, 0);
    keep.sort((left, right) => left.usedAt - right.usedAt);
    for (const entry of keep) {
      if (total <= this.#maxBytes) break;
      if (await this.#remove(entry)) {
        removed += 1;
        total -= entry.bytes;
      } else {
        failures.push(entry.path);
      }
    }
    return { removed, failures };
  }

  /**
   * The entries the cache holds now, newest use first, for an operator's question.
   *
   * @returns Every complete entry, and the entry that would be removed next.
   */
  async list(): Promise<
    readonly { readonly path: string; readonly usedAt: number; readonly bytes: number }[]
  > {
    return (await this.#scan()).map((entry) => ({
      path: entry.path,
      usedAt: entry.usedAt,
      bytes: entry.bytes,
    }));
  }

  /** Read one entry marker, or undefined when it is absent or not a marker this cache wrote. */
  async #readMetadata(path: string): Promise<CacheEntryMetadata | undefined> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return undefined;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return undefined;
    }
    const parsed = v.safeParse(CacheEntrySchema, value);
    return parsed.success ? parsed.output : undefined;
  }

  /** Write one entry marker, replacing it atomically. */
  async #writeMetadata(path: string, metadata: CacheEntryMetadata): Promise<void> {
    const staged = path + ".tmp-" + randomUUID();
    await writeFile(staged, JSON.stringify(metadata) + "\n");
    await rename(staged, path);
  }

  /** Delete one entry's directory, answering whether it is gone. */
  async #remove(entry: CacheEntry): Promise<boolean> {
    try {
      await rm(entry.directory, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Walk the cache and describe every complete entry, plus the staging directories a crash left.
   *
   * @returns The entries, with their marker's facts; a directory without a parseable marker is a
   * staging directory and is removed rather than listed.
   */
  async #scan(): Promise<readonly CacheEntry[]> {
    const entries: CacheEntry[] = [];
    for (const workspace of await this.#children(this.#root)) {
      for (const pathHash of await this.#children(workspace)) {
        for (const version of await this.#children(pathHash)) {
          for (const operation of await this.#children(version)) {
            const metadataPath = join(operation, ENTRY_MARKER);
            const metadata = await this.#readMetadata(metadataPath);
            if (metadata === undefined) {
              // The entry directory exists but its marker does not: a write that never finished.
              await rm(operation, { recursive: true, force: true }).catch(() => undefined);
              continue;
            }
            entries.push({
              path: operation,
              directory: operation,
              metadataPath,
              usedAt: metadata.usedAt,
              bytes: metadata.bytes,
              files: 2,
            });
          }
        }
      }
    }
    return entries;
  }

  /** The directories directly under one path; an absent or unreadable directory is empty. */
  async #children(path: string): Promise<readonly string[]> {
    let names: string[];
    try {
      const listed = await readdir(path, { withFileTypes: true });
      names = listed.filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
    } catch {
      return [];
    }
    return names;
  }
}

/** The marker as it is written; the schema is what turns a file back into one. */
const CacheEntrySchema: v.GenericSchema<unknown, CacheEntryMetadata> = v.object({
  usedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  bytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
  sha256: v.pipe(v.string(), v.regex(OFFICE_SHA256_PATTERN, "a digest is sha256:<64 hex>")),
  pages: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  missingFonts: v.array(v.string()),
  engine: v.object({
    id: v.pipe(v.string(), v.minLength(1)),
    version: v.pipe(v.string(), v.minLength(1)),
  }),
});
