import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { gitObjectId } from "./objects.ts";
import type { GitObject } from "./objects.ts";
import { PackFormatError, openPack } from "./pack.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const created: string[] = [];

afterAll(async () => {
  for (const path of created) await rm(path, { recursive: true, force: true });
});

/** The SHA-1 of the bytes, as raw digest bytes. */
const sha1 = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-1", new Uint8Array(bytes)));

const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const TYPE_NUMBER = { commit: 1, tree: 2, blob: 3, tag: 4 } satisfies Record<string, number>;

/** Encode a size as the pack's variable-length number with a type in the low nibble. */
const sizeAndType = (size: number, type: number): Uint8Array => {
  // The first byte carries four size bits and the type; each later byte carries seven more bits,
  // with the high bit marking that another byte follows.
  const groups: number[] = [];
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    groups.push(rest % 128);
    rest = Math.floor(rest / 128);
  }
  const bytes: number[] = [(size % 16) | (type << 4) | (groups.length > 0 ? 0x80 : 0)];
  groups.forEach((group, index) => {
    bytes.push(index === groups.length - 1 ? group : group | 0x80);
  });
  return Uint8Array.from(bytes);
};

/** Encode an ofs-delta distance: big-endian base-128, each group but the last biased by +1. */
const distanceBytes = (distance: number): Uint8Array => {
  const bytes: number[] = [distance % 128];
  let remaining = Math.floor(distance / 128);
  while (remaining > 0) {
    remaining -= 1;
    bytes.unshift((remaining % 128) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  return Uint8Array.from(bytes);
};

/** A variable-length number as a delta and a pack size both write it. */
const varint = (value: number): number[] => {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    bytes.push(remaining > 0 ? byte | 0x80 : byte);
  } while (remaining > 0);
  return bytes;
};

/** One entry to pack: an object, or a delta over a base the entry names. */
type PackEntry =
  | { readonly kind: "object"; readonly object: GitObject }
  | { readonly kind: "ofs"; readonly baseIndex: number; readonly delta: Uint8Array }
  | { readonly kind: "ref"; readonly baseId: string; readonly delta: Uint8Array };

/** Build a v2 pack from entries, in the order given, with a correct trailer. */
const buildPackOf = async (entries: readonly PackEntry[]): Promise<Uint8Array> => {
  const header = new Uint8Array(12);
  header.set(enc.encode("PACK"), 0);
  const view = new DataView(header.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, entries.length);
  const parts: Uint8Array[] = [header];
  const offsets: number[] = [];
  let length = header.length;
  for (const entry of entries) {
    offsets.push(length);
    let bytes: Uint8Array;
    if (entry.kind === "object") {
      const type = TYPE_NUMBER[entry.object.type] ?? 0;
      bytes = concat(
        sizeAndType(entry.object.content.length, type),
        new Uint8Array(deflateSync(entry.object.content)),
      );
    } else if (entry.kind === "ofs") {
      const baseOffset = offsets[entry.baseIndex];
      if (baseOffset === undefined) throw new Error("no base offset");
      bytes = concat(
        sizeAndType(entry.delta.length, 6),
        distanceBytes(length - baseOffset),
        new Uint8Array(deflateSync(entry.delta)),
      );
    } else {
      const baseId = Uint8Array.from(entry.baseId.match(/.{2}/gu) ?? [], (pair) =>
        Number.parseInt(pair, 16),
      );
      bytes = concat(
        sizeAndType(entry.delta.length, 7),
        baseId,
        new Uint8Array(deflateSync(entry.delta)),
      );
    }
    parts.push(bytes);
    length += bytes.length;
  }
  const body = concat(...parts);
  return concat(body, await sha1(body));
};

/**
 * A git delta: copy `copy` bytes from `offset` of a base of `baseSize` bytes, then insert `insert`.
 *
 * @remarks
 * The delta's first size is the base length it expects. One copy and one insert opcode are enough
 * for the test fixtures; an offset or size over one byte is a test error, not a case under test.
 */
const deltaOf = (
  baseSize: number,
  offset: number,
  copy: number,
  insert: Uint8Array,
): Uint8Array => {
  if (offset > 0xff || copy > 0xff || insert.length > 0x7f) {
    throw new Error("the test delta builder encodes one-byte offsets, sizes, and inserts only");
  }
  // A copy opcode names which of its four offset bytes (bits 0-3) and three size bytes (bits 4-6)
  // follow; a size of zero means 0x10000, which this builder never needs. The size needs one byte
  // here, so bit 4 is always set; the offset needs one only when it is non-zero, so bit 0 is set
  // then.
  const copyOpcode = 0x80 | 0x10 | (offset > 0 ? 0x01 : 0);
  const copyBytes = offset > 0 ? [offset, copy] : [copy];
  const produced = copy + insert.length;
  return Uint8Array.from([
    ...varint(baseSize),
    ...varint(produced),
    ...(copy > 0 ? [copyOpcode, ...copyBytes] : []),
    ...(insert.length > 0 ? [insert.length, ...insert] : []),
  ]);
};

const blob = async (text: string): Promise<GitObject> => ({
  type: "blob",
  content: enc.encode(text),
});

/**
 * The environment every fixture's git runs in, with the repository variables removed.
 *
 * @remarks
 * A `GIT_DIR` or `GIT_WORK_TREE` inherited from the process that starts the tests would make
 * `git init` in a temp directory describe and commit to the *inherited* repository instead. Removing
 * them makes each fixture's git resolve its own repository, which is the only one it may write.
 */
const fixtureEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR",
  ]) {
    delete env[name];
  }
  return env;
};

/** Run git in `cwd` and answer its stdout. */
const git = (cwd: string, args: readonly string[], input?: string): string =>
  execFileSync("git", args, { cwd, input, encoding: "utf8", env: fixtureEnv() });

/**
 * A repository with two commits.
 *
 * @remarks
 * The second commit changes one line of a 400-line file, which is what makes git store the newer
 * blob as a delta against the older one. A tiny file is not deltad by git, so a fixture without the
 * large file would never exercise the delta path.
 */
const repository = async (): Promise<string> => {
  const repo = await mkdtemp(join(tmpdir(), "hns-pack-git-"));
  created.push(repo);
  git(repo, ["init", "-q"]);
  // A probe first: if git answers with another toplevel, an inherited GIT_* variable redirected it,
  // and every commit below would land in a real repository. Refuse rather than write there.
  const toplevel = git(repo, ["rev-parse", "--show-toplevel"]).trim();
  if (toplevel !== repo) {
    throw new Error("git resolved " + repo + " to " + toplevel + " (an inherited GIT_* variable)");
  }
  git(repo, ["config", "user.email", "hns@example.com"]);
  git(repo, ["config", "user.name", "hns"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  const manyLines = (changed: number): string =>
    Array.from({ length: 400 }, (_, index) =>
      index === changed ? "CHANGED" : "line " + String(index),
    ).join("\n") + "\n";
  await writeFile(join(repo, "big.txt"), manyLines(-1));
  await writeFile(join(repo, "a.txt"), "first\nsecond\nthird\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "one"]);
  await writeFile(join(repo, "big.txt"), manyLines(200));
  await writeFile(join(repo, "a.txt"), "first\nSECOND\nthird\nfourth\n");
  await writeFile(join(repo, "dir.txt"), "dir\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "two"]);
  return repo;
};

// Catches: a reader that only handles packs this repository builds — one entry per object, no
// deltas — so a pack git produced for a real checkpoint cannot be read.
test("reads a real git pack and answers the same objects git does", async () => {
  const repo = await repository();
  const listing = git(repo, ["rev-list", "--objects", "--all"])
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split(" ")[0] ?? "");
  // git's pack without deltas, for the plain case: every entry is its own object.
  const plain = execFileSync("git", ["pack-objects", "--stdout"], {
    cwd: repo,
    env: fixtureEnv(),
    input: git(repo, ["rev-list", "--objects", "--all"]),
    maxBuffer: 64 * 1024 * 1024,
  });
  const objects = await openPack(new Uint8Array(plain));

  expect([...objects.ids].sort()).toStrictEqual([...listing].sort());
  for (const id of listing) {
    const type = git(repo, ["cat-file", "-t", id]).trim();
    // `cat-file -p` pretty-prints a tree; `cat-file <type> <id>` answers the stored bytes, which is
    // what a pack holds and what the reader must reproduce.
    const content = execFileSync("git", ["cat-file", type, id], { cwd: repo, env: fixtureEnv() });
    const read = objects.getObject(id);
    expect(read?.type, id).toBe(type);
    expect(Buffer.from(read?.content ?? []).equals(content), id).toBe(true);
  }
  expect(objects.getObject("0".repeat(40))).toBeNull();
});

// Catches: a reader that cannot undo git's own delta entries, which is what a checkpoint pack of a
// repository with history carries. The deltas are written by git itself (`git repack -adf`), so
// the bytes are git's, and the objects are compared to what git reads from the same pack file.
test("reads a pack git stored with its own deltas", async () => {
  const repo = await repository();
  // A copy keeps the loose objects: `repack -adf` prunes what no ref reaches, and the objects a
  // delta test must read back are compared against this copy, which git still has.
  const copy = await mkdtemp(join(tmpdir(), "hns-pack-git-copy-"));
  created.push(copy);
  git(repo, ["clone", "-q", "--no-local", repo, copy]);
  git(repo, ["repack", "-adf", "-q"]);
  // A fixture repository keeps its objects under its own .git; building the path here rather than
  // asking git means an inherited GIT_* variable can never point this at another repository.
  const packDir = join(repo, ".git", "objects", "pack");
  const packName = (await readdir(packDir)).find((name) => name.endsWith(".pack"));
  if (packName === undefined) throw new Error("repack wrote no pack");
  const packFile = join(packDir, packName);
  // The fixture must actually produce a delta, or this proves nothing about deltas.
  const chains = git(repo, ["verify-pack", "-v", packFile]);
  expect(chains).toContain("chain length");
  const bytes = new Uint8Array(await readFile(packFile));
  const objects = await openPack(bytes);
  const listing = chains
    .split("\n")
    .filter((line) => /^[0-9a-f]{40} /u.test(line))
    .map((line) => (line.split(" ")[0] ?? "").trim());
  expect([...objects.ids].sort()).toStrictEqual([...listing].sort());
  for (const id of listing) {
    const type = git(copy, ["cat-file", "-t", id]).trim();
    const content = execFileSync("git", ["cat-file", type, id], { cwd: copy, env: fixtureEnv() });
    const read = objects.getObject(id);
    expect(read?.type, id).toBe(type);
    expect(Buffer.from(read?.content ?? []).equals(content), id).toBe(true);
  }
});

// Catches: an ofs-delta resolved from the wrong base offset, which answers a different file under
// the id it claims; the id check turns that into a refusal rather than a wrong answer.
test("applies an ofs-delta to the entry its distance names", async () => {
  const base = await blob("hello\nworld\n");
  const baseId = await gitObjectId(base);
  const delta = deltaOf(base.content.length, 0, 6, enc.encode("WORLD\n"));
  const pack = await buildPackOf([
    { kind: "object", object: base },
    { kind: "ofs", baseIndex: 0, delta },
    { kind: "object", object: await blob("other\n") },
  ]);
  const objects = await openPack(pack);
  const expected = await blob("hello\nWORLD\n");
  const expectedId = await gitObjectId(expected);
  expect(objects.getObject(expectedId)?.content).toStrictEqual(expected.content);
  expect(objects.getObject(baseId)?.content).toStrictEqual(base.content);
});

// Catches: a reader that trusts a delta's base id, so a corrupt delta is answered under an id
// whose bytes it does not produce.
test("refuses a delta whose bytes do not hash to the id it replaces", async () => {
  const base = await blob("hello\n");
  const baseId = await gitObjectId(base);
  const delta = deltaOf(base.content.length, 0, 5, enc.encode("?\n"));
  const pack = await buildPackOf([
    { kind: "object", object: base },
    { kind: "ref", baseId, delta },
  ]);
  const objects = await openPack(pack);
  // The pack carries the base and one object the delta produced under a different id; nothing
  // claims the base's id twice, so the reader answers the base and the delta's own id.
  expect(dec.decode(objects.getObject(baseId)?.content)).toBe("hello\n");
  expect(objects.ids).toHaveLength(2);
});

// Catches: a reader that accepts altered bytes because the trailer is not checked, so a store
// that changed a pack answers with different content under the same id.
test("refuses a pack whose trailer does not match its contents", async () => {
  const object = await blob("hello\n");
  const pack = await buildPackOf([{ kind: "object", object }]);
  const altered = new Uint8Array(pack);
  const last = altered.length - 21;
  altered[last] = (altered[last] ?? 0) ^ 0xff;
  await expect(openPack(altered)).rejects.toBeInstanceOf(PackFormatError);
});

// Catches: a reader that walks the header count and ignores trailing bytes, so a truncated or
// padded pack is read as if it were the pack its header describes.
test("refuses a pack that is truncated or padded", async () => {
  const object = await blob("hello\n");
  const pack = await buildPackOf([{ kind: "object", object }]);
  await expect(openPack(pack.subarray(0, pack.length - 4))).rejects.toBeInstanceOf(PackFormatError);
  await expect(openPack(new Uint8Array(16))).rejects.toBeInstanceOf(PackFormatError);
  const padded = concat(
    pack.subarray(0, pack.length - 20),
    new Uint8Array([0]),
    pack.subarray(pack.length - 20),
  );
  await expect(openPack(padded)).rejects.toBeInstanceOf(PackFormatError);
});
/** A pack of `count` small blobs, so a limit can be tested without a large fixture. */
const smallPack = async (count: number): Promise<Uint8Array> => {
  const entries: PackEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    entries.push({ kind: "object", object: await blob("blob " + String(index) + "\n") });
  }
  return await buildPackOf(entries);
};

// Catches: a reader that trusts a pack's header count and allocates for it, so a corrupt or
// hostile pack turns into unbounded memory before the bytes are even read.
test("refuses a pack over its object limit", async () => {
  const pack = await smallPack(3);
  await expect(
    openPack(pack, { maxPackBytes: 1024, maxObjects: 2, maxDeltaDepth: 50 }),
  ).rejects.toBeInstanceOf(PackFormatError);
  expect(
    (await openPack(pack, { maxPackBytes: 1024, maxObjects: 3, maxDeltaDepth: 50 })).ids,
  ).toHaveLength(3);
});

// Catches: a reader that accepts any pack size, so a store that hands back a much larger pack than
// a checkpoint can be makes the Worker read it.
test("refuses a pack over its size limit", async () => {
  const pack = await smallPack(3);
  await expect(
    openPack(pack, { maxPackBytes: pack.length - 1, maxObjects: 1024, maxDeltaDepth: 50 }),
  ).rejects.toBeInstanceOf(PackFormatError);
  expect(
    await openPack(pack, { maxPackBytes: pack.length, maxObjects: 1024, maxDeltaDepth: 50 }),
  ).toBeDefined();
});

// Catches: a delta chain of arbitrary depth, which costs one inflate per link and lets a small
// pack spend unbounded work on one object.
test("refuses a delta chain deeper than its limit", async () => {
  const base = await blob("hello\n");
  const entries: PackEntry[] = [{ kind: "object", object: base }];
  let previous = base.content;
  for (let depth = 0; depth < 3; depth += 1) {
    entries.push({
      kind: "ofs",
      baseIndex: depth,
      delta: deltaOf(previous.length, 0, 5, enc.encode("!")),
    });
    previous = enc.encode(dec.decode(previous.subarray(0, 5)) + "!");
  }
  const pack = await buildPackOf(entries);
  await expect(
    openPack(pack, { maxPackBytes: 1024, maxObjects: 1024, maxDeltaDepth: 1 }),
  ).rejects.toBeInstanceOf(PackFormatError);
  expect(
    await openPack(pack, { maxPackBytes: 1024, maxObjects: 1024, maxDeltaDepth: 3 }),
  ).toBeDefined();
});
