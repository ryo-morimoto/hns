import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { officeCachePath } from "@hns/core/office";
import type { OfficeCacheKey } from "@hns/core/office";
import { OFFICE_CACHE_MAX_BYTES, OFFICE_CACHE_TTL_MS, OfficeCache } from "./cache.ts";

// The cache is what makes the second open of a document instant, and what keeps a machine from
// filling up: one key per artifact, seven days of use, two gigabytes, least recently used first.

/** A key whose parts are all in their contract spelling. */
function key(overrides: Partial<OfficeCacheKey> = {}): OfficeCacheKey {
  return {
    workspaceId: "ws-1",
    pathHash: "0123456789abcdef",
    version: "sha256:" + "a".repeat(64),
    operation: "preview",
    paramsHash: "fedcba9876543210",
    ...overrides,
  };
}

/** A cache in a fresh directory, and a way to remove it. */
async function withCache(
  run: (cache: OfficeCache, root: string, now: { value: number }) => Promise<void>,
  options: { readonly ttlMs?: number; readonly maxBytes?: number } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hns-office-cache-"));
  const now = { value: 1_000_000 };
  const cache = new OfficeCache({
    root,
    ttlMs: options.ttlMs,
    maxBytes: options.maxBytes,
    now: () => now.value,
  });
  try {
    await run(cache, root, now);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The facts an entry records beside its bytes. */
const facts = {
  sha256: "sha256:" + "b".repeat(64),
  missingFonts: [],
  engine: { id: "ibisoffice", version: "0.8.7" },
  pages: 2,
} as const;

// Catches: a store that is not found by the lookup of the same key (the two disagree about the
// path), and a lookup that answers an entry whose bytes changed under it.
test("a stored entry is found by its key, and a changed file is not", async () => {
  await withCache(async (cache) => {
    const stored = await cache.store(key(), new Uint8Array([1, 2, 3]), facts);
    expect(stored).toBe(join(cache.root, officeCachePath(key())));
    const hit = await cache.lookup(key());
    expect(hit?.path).toBe(stored);
    expect(hit?.metadata.bytes).toBe(3);
    expect(hit?.metadata.pages).toBe(2);
    expect(hit?.metadata.sha256).toBe(facts.sha256);
    // The bytes on disk are no longer the size the entry recorded: a lookup answers nothing, so
    // the next job regenerates rather than serving a truncated file.
    await writeFile(stored, new Uint8Array([9]));
    expect(await cache.lookup(key())).toBeUndefined();
  });
});

// Catches: one key's entry answering another's (all five parts are the path, so a store that
// dropped one would collide), and an entry with a different operation or workspace.
test("different keys are different entries", async () => {
  await withCache(async (cache) => {
    await cache.store(key(), new Uint8Array([1]), facts);
    expect(await cache.lookup(key())).toBeDefined();
    expect(await cache.lookup(key({ paramsHash: "0000000000000000" }))).toBeUndefined();
    expect(await cache.lookup(key({ operation: "render" }))).toBeUndefined();
    expect(await cache.lookup(key({ workspaceId: "ws-2" }))).toBeUndefined();
  });
});

// Catches: a marker written before the bytes, so a crash leaves an entry that looks complete.
test("an entry directory without its marker is not an entry", async () => {
  await withCache(async (cache) => {
    const path = join(cache.root, officeCachePath(key()));
    const directory = path.slice(0, path.lastIndexOf("/"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true });
    await writeFile(path, new Uint8Array([1]));
    expect(await cache.lookup(key())).toBeUndefined();
  });
});

// Catches: an entry past its seven days kept (the machine would grow forever), and a fresh one
// swept with it.
test("an entry older than the TTL is swept, and a fresh one is not", async () => {
  await withCache(
    async (cache, _root, now) => {
      await cache.store(key({ pathHash: "1111111111111111" }), new Uint8Array([1]), facts);
      now.value += OFFICE_CACHE_TTL_MS - 1;
      await cache.store(key({ pathHash: "2222222222222222" }), new Uint8Array([1]), facts);
      now.value += 2;
      const swept = await cache.sweep();
      expect(swept.removed).toBe(1);
      expect(swept.failures).toStrictEqual([]);
      expect(await cache.lookup(key({ pathHash: "1111111111111111" }))).toBeUndefined();
      expect(await cache.lookup(key({ pathHash: "2222222222222222" }))).toBeDefined();
    },
    { ttlMs: OFFICE_CACHE_TTL_MS },
  );
});

// Catches: the size bound ignored (a machine with a 2 GB cache turns into a disk problem), and
// the eviction order chosen by age rather than by use: the entry used yesterday stays, the one
// written last week and never opened goes.
test("over the size bound, the least recently used entries go first", async () => {
  await withCache(
    async (cache, _root, now) => {
      const old = key({ pathHash: "aaaaaaaaaaaaaaaa" });
      const recentlyUsed = key({ pathHash: "bbbbbbbbbbbbbbbb" });
      const newest = key({ pathHash: "cccccccccccccccc" });
      await cache.store(old, new Uint8Array(8), facts);
      now.value += 10;
      await cache.store(recentlyUsed, new Uint8Array(8), facts);
      now.value += 10;
      // The old entry is opened again: its use time is now the latest.
      expect(await cache.lookup(old)).toBeDefined();
      now.value += 10;
      await cache.store(newest, new Uint8Array(8), facts);
      // Three entries of 8 bytes against a bound of 16: one must go, and it is the oldest use.
      const swept = await cache.sweep();
      expect(swept.removed).toBe(1);
      expect(await cache.lookup(old)).toBeDefined();
      expect(await cache.lookup(newest)).toBeDefined();
      expect(await cache.lookup(recentlyUsed)).toBeUndefined();
    },
    { maxBytes: 16 },
  );
});

// Catches: a default that is not the documented one (seven days / two gigabytes, docs §4).
test("the cache's own defaults are the contract's", () => {
  expect(OFFICE_CACHE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  expect(OFFICE_CACHE_MAX_BYTES).toBe(2 * 1024 * 1024 * 1024);
});

// Catches: a write that is not atomic: the entry's directory either holds a complete entry or
// nothing, never half of one, and a failed store leaves nothing at the key.
test("a store is atomic: the key's directory holds the bytes and the marker together", async () => {
  await withCache(async (cache) => {
    const stored = await cache.store(key(), new Uint8Array([4, 5]), facts);
    const directory = stored.slice(0, stored.lastIndexOf("/"));
    expect((await readdir(directory)).sort()).toStrictEqual(["entry.json", "pdf"]);
    expect((await stat(stored)).size).toBe(2);
    expect((await readFile(stored)).byteLength).toBe(2);
  });
});
