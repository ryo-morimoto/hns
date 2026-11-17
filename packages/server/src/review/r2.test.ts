import { expect, test } from "vitest";
import { gitObjectId } from "@hns/workspace/objects";
import type { ObjectBody } from "@hns/workspace/objects";
import { checkpointPackKey } from "@hns/workspace/objects";
import { R2ReviewSource, REVIEW_LIMITS } from "./r2.ts";
import type { ReviewBucket, ReviewLimits } from "./r2.ts";
import { ReviewSourceError } from "./source.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const HEAD = "a".repeat(40);

/**
 * A bucket that answers one key and nothing else, so a source test needs no pack builder of its own.
 *
 * @remarks
 * `get` answers a body whose `arrayBuffer` resolves the bytes; any other key is null, which is what
 * R2 answers for a missing object.
 */
class FakeBucket implements ReviewBucket {
  readonly stored = new Map<string, Uint8Array>();
  readonly reads: string[] = [];
  /** When true, `get` throws, which is the binding failing rather than answering. */
  fails = false;

  put(key: string, bytes: Uint8Array): void {
    this.stored.set(key, bytes);
  }

  async get(key: string): Promise<ObjectBody | null> {
    this.reads.push(key);
    if (this.fails) throw new Error("the bucket is unavailable");
    const bytes = this.stored.get(key);
    if (bytes === undefined) return null;
    return { arrayBuffer: async (): Promise<ArrayBuffer> => new Uint8Array(bytes).buffer };
  }
}

/** The failure a read refused with, or undefined when it answered. */
const failureOf = async (read: () => Promise<object>): Promise<string | undefined> => {
  try {
    await read();
    return undefined;
  } catch (error) {
    return error instanceof ReviewSourceError ? error.code : "not-a-review-source-error";
  }
};

const limits = (pack: Partial<ReviewLimits["pack"]>, maxFileBytes = 1024 * 1024): ReviewLimits => ({
  pack: { ...REVIEW_LIMITS.pack, ...pack },
  maxFileBytes,
});

// Catches: a source that cannot tell a store failure from an absent commit, so a missing pack is
// reported as a store error and a store error as a missing commit.
test("a missing pack is not_found and a failing store propagates", async () => {
  const bucket = new FakeBucket();
  const source = new R2ReviewSource(bucket);
  expect(await failureOf(() => source.log(HEAD))).toBe("not_found");
  expect(bucket.reads).toStrictEqual([checkpointPackKey(HEAD)]);
  bucket.fails = true;
  await expect(source.log(HEAD)).rejects.toThrow("the bucket is unavailable");
});

// Catches: a commit id that is not 40 hex being used as a store key, so a caller can name a key
// outside `checkpoints/`.
test("refuses a value that is not a commit id", async () => {
  const source = new R2ReviewSource(new FakeBucket());
  for (const commit of ["", "HEAD", "refs/hns/checkpoints/run-1", "A".repeat(40), HEAD + "0"]) {
    expect(await failureOf(() => source.log(commit)), commit).toBe("invalid_request");
    expect(await failureOf(() => source.readTree(commit, "")), commit).toBe("invalid_request");
    expect(await failureOf(() => source.readFile(commit, "a.txt")), commit).toBe("invalid_request");
  }
});

// Catches: a path that leaves the tree being read as a path inside it, which would let a review
// read another commit or another project.
test("refuses a path that leaves the tree", async () => {
  const source = new R2ReviewSource(new FakeBucket());
  for (const path of ["../a.txt", "/etc/passwd", "src/../../a.txt", "./a.txt", "a//b", "a\0b"]) {
    expect(await failureOf(() => source.readTree(HEAD, path)), path).toBe("invalid_request");
    expect(await failureOf(() => source.readFile(HEAD, path)), path).toBe("invalid_request");
  }
});

// Catches: a pack at the key that does not parse being answered with empty trees, which would look
// like an empty commit rather than an unreadable one.
test("a pack that cannot be read is unavailable", async () => {
  const bucket = new FakeBucket();
  bucket.put(checkpointPackKey(HEAD), enc.encode("not a pack at all, not even close"));
  const source = new R2ReviewSource(bucket);
  expect(await failureOf(() => source.log(HEAD))).toBe("unavailable");
});

// Catches: a pack over the size bound being read anyway, which on a Worker is a memory limit and on
// a review is a way to make one request cost a whole pack.
test("a pack over the limit is too_large", async () => {
  const bucket = new FakeBucket();
  bucket.put(checkpointPackKey(HEAD), new Uint8Array(64));
  const source = new R2ReviewSource(bucket, limits({ maxPackBytes: 32 }));
  expect(await failureOf(() => source.log(HEAD))).toBe("too_large");
});

// Catches: a source that opens and inflates one commit's pack once per read, so a diff that walks
// many directories pays the pack's cost many times.
test("opens a commit's pack once, however many reads name it", async () => {
  const pack = await singleFilePack("a.txt", "hello\n");
  const bucket = new FakeBucket();
  bucket.put(checkpointPackKey(pack.commit), pack.bytes);
  const source = new R2ReviewSource(bucket);
  expect(dec.decode((await source.readFile(pack.commit, "a.txt")).bytes)).toBe("hello\n");
  await source.readTree(pack.commit, "");
  await source.readFile(pack.commit, "a.txt");
  expect(bucket.reads).toStrictEqual([checkpointPackKey(pack.commit)]);
});

/** A pack carrying one commit with one file at the root, built here rather than by git. */
const singleFilePack = async (
  path: string,
  content: string | Uint8Array,
): Promise<{ readonly bytes: Uint8Array; readonly commit: string; readonly blob: string }> => {
  const blob: GitObjectBytes = {
    type: "blob",
    content: content instanceof Uint8Array ? content : enc.encode(content),
  };
  const blobId = await gitObjectId(blob);
  const tree = treeObject([{ mode: "100644", name: path, id: blobId }]);
  const treeId = await gitObjectId(tree);
  const commit: GitObjectBytes = {
    type: "commit",
    content: enc.encode(
      "tree " +
        treeId +
        "\nauthor hns <hns@example.com> 1700000000 +0000\n" +
        "committer hns <hns@example.com> 1700000000 +0000\n\nhns checkpoint",
    ),
  };
  const commitId = await gitObjectId(commit);
  const bytes = await packOf([blob, tree, commit]);
  return { bytes, commit: commitId, blob: blobId };
};

/** One object as the pack builder takes it. */
interface GitObjectBytes {
  readonly type: "blob" | "tree" | "commit";
  readonly content: Uint8Array;
}

/** A git tree object from `(mode, name, id)` entries, in the order given. */
const treeObject = (
  entries: readonly { mode: string; name: string; id: string }[],
): GitObjectBytes => {
  const parts: number[] = [];
  for (const entry of entries) {
    for (const byte of enc.encode(entry.mode + " " + entry.name)) parts.push(byte);
    parts.push(0);
    for (let index = 0; index < 20; index += 1) {
      parts.push(Number.parseInt(entry.id.slice(index * 2, index * 2 + 2), 16));
    }
  }
  return { type: "tree", content: Uint8Array.from(parts) };
};

/** Build a v2 pack of the objects, with a correct trailer (mirrors the workspace pack test). */
const packOf = async (objects: readonly GitObjectBytes[]): Promise<Uint8Array> => {
  const { deflateSync } = await import("node:zlib");
  const typeNumber: Readonly<Record<GitObjectBytes["type"], number>> = {
    commit: 1,
    tree: 2,
    blob: 3,
  };
  const headerByte = (size: number, type: number): number[] => {
    const groups: number[] = [];
    let rest = Math.floor(size / 16);
    while (rest > 0) {
      groups.push(rest % 128);
      rest = Math.floor(rest / 128);
    }
    const bytes = [(size % 16) | (type << 4) | (groups.length > 0 ? 0x80 : 0)];
    groups.forEach((group, index) =>
      bytes.push(index === groups.length - 1 ? group : group | 0x80),
    );
    return bytes;
  };
  const encoded: number[] = [0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, objects.length];
  for (const object of objects) {
    encoded.push(...headerByte(object.content.length, typeNumber[object.type]));
    for (const byte of deflateSync(object.content)) encoded.push(byte);
  }
  const body = Uint8Array.from(encoded);
  const trailer = new Uint8Array(await crypto.subtle.digest("SHA-1", new Uint8Array(body)));
  const out = new Uint8Array(body.length + trailer.length);
  out.set(body, 0);
  out.set(trailer, body.length);
  return out;
};

// Catches: a commit object read as its raw bytes (or a tree id taken from the wrong line), so the
// log a reviewer sees does not name the tree the diff reads.
test("reads a commit, its tree, and a file from one pack", async () => {
  const pack = await singleFilePack("a.txt", "hello\n");
  const bucket = new FakeBucket();
  bucket.put(checkpointPackKey(pack.commit), pack.bytes);
  const source = new R2ReviewSource(bucket);

  const commit = await source.log(pack.commit);
  expect(commit.commit).toBe(pack.commit);
  expect(commit.message).toBe("hns checkpoint");
  expect(commit.committedAt).toBe("2023-11-14T22:13:20.000Z");

  const root = await source.readTree(pack.commit, "");
  expect(root).toStrictEqual([
    { path: "a.txt", kind: "blob", mode: "100644", object: pack.blob, size: 6 },
  ]);

  const file = await source.readFile(pack.commit, "a.txt");
  expect(file.object).toBe(pack.blob);
  expect(file.path).toBe("a.txt");
  expect(file.contentType).toBe("text/plain");
  expect(dec.decode(file.bytes)).toBe("hello\n");
});

// Catches: a tree read that recurses instead of answering one directory, so a reviewer cannot ask
// for a directory that is large without paying for every file below it.
test("reads one directory at a time, with ids and sizes from the tree", async () => {
  const blob: GitObjectBytes = { type: "blob", content: enc.encode("data\n") };
  const blobId = await gitObjectId(blob);
  const sub = treeObject([{ mode: "100644", name: "b.txt", id: blobId }]);
  const subId = await gitObjectId(sub);
  const root = treeObject([
    { mode: "040000", name: "src", id: subId },
    { mode: "100644", name: "a.txt", id: blobId },
  ]);
  const rootId = await gitObjectId(root);
  const commit: GitObjectBytes = {
    type: "commit",
    content: enc.encode(
      "tree " + rootId + "\ncommitter hns <h@e> 1700000000 +0000\n\nhns checkpoint",
    ),
  };
  const commitId = await gitObjectId(commit);
  const bucket = new FakeBucket();
  bucket.put(checkpointPackKey(commitId), await packOf([blob, sub, root, commit]));
  const source = new R2ReviewSource(bucket);

  expect(await source.readTree(commitId, "")).toStrictEqual([
    { path: "src", kind: "tree", mode: "40000", object: subId, size: 0 },
    { path: "a.txt", kind: "blob", mode: "100644", object: blobId, size: 5 },
  ]);
  expect(await source.readTree(commitId, "src")).toStrictEqual([
    { path: "b.txt", kind: "blob", mode: "100644", object: blobId, size: 5 },
  ]);
  expect(await failureOf(() => source.readTree(commitId, "a.txt"))).toBe("not_found");
  expect(await failureOf(() => source.readFile(commitId, "src"))).toBe("not_found");
  expect(await failureOf(() => source.readFile(commitId, "missing.txt"))).toBe("not_found");
});

// Catches: a file read that returns text or refuses a binary, which would corrupt an image.
test("reads a file as bytes, with a content type hint", async () => {
  // 0x89 is the PNG signature's first byte; it is not valid UTF-8, so a text read would fail.
  const pack = await singleFilePack("image.png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
  const bucket = new FakeBucket();
  bucket.put(checkpointPackKey(pack.commit), pack.bytes);
  const source = new R2ReviewSource(bucket);
  const file = await source.readFile(pack.commit, "image.png");
  expect(Array.from(file.bytes)).toStrictEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(file.contentType).toBe("image/png");
});

// Catches: a symlink answered as file content, so a reviewer renders a link as the file it points
// at; the tree says it is not a file even though its bytes are readable.
test("tells a symlink from a file in a tree", async () => {
  const target: GitObjectBytes = { type: "blob", content: enc.encode("a.txt") };
  const targetId = await gitObjectId(target);
  const root = treeObject([{ mode: "120000", name: "link", id: targetId }]);
  const rootId = await gitObjectId(root);
  const commit: GitObjectBytes = {
    type: "commit",
    content: enc.encode(
      "tree " + rootId + "\ncommitter hns <h@e> 1700000000 +0000\n\nhns checkpoint",
    ),
  };
  const commitId = await gitObjectId(commit);
  const bucket = new FakeBucket();
  bucket.put(checkpointPackKey(commitId), await packOf([target, root, commit]));
  const source = new R2ReviewSource(bucket);
  // The contract has no symlink kind, so the entry is a blob; what makes it a link is its mode,
  // and a walk must not descend into it as if it were a directory.
  const [entry] = await source.readTree(commitId, "");
  expect(entry?.kind).toBe("blob");
  // The mode is what says it is a link rather than a file with the same bytes.
  expect(entry?.mode).toBe("120000");
  expect(await failureOf(() => source.readTree(commitId, "link"))).toBe("not_found");
});

// Catches: a file over the review limit being read and returned, which is the whole point of the
// limit: the caller gets too_large and offers a download instead.
test("a file over the limit is too_large", async () => {
  const pack = await singleFilePack("big.txt", "0123456789");
  const bucket = new FakeBucket();
  bucket.put(checkpointPackKey(pack.commit), pack.bytes);
  const source = new R2ReviewSource(bucket, limits({}, 4));
  expect(await failureOf(() => source.readFile(pack.commit, "big.txt"))).toBe("too_large");
});

// Catches: a pack that does not carry an object the tree names answered as an empty file.
test("an object the pack does not carry is not_found", async () => {
  const target: GitObjectBytes = { type: "blob", content: enc.encode("x") };
  const missingId = "f".repeat(40);
  const root = treeObject([{ mode: "100644", name: "gone.txt", id: missingId }]);
  const rootId = await gitObjectId(root);
  const commit: GitObjectBytes = {
    type: "commit",
    content: enc.encode(
      "tree " + rootId + "\ncommitter hns <h@e> 1700000000 +0000\n\nhns checkpoint",
    ),
  };
  const commitId = await gitObjectId(commit);
  const bucket = new FakeBucket();
  bucket.put(checkpointPackKey(commitId), await packOf([target, root, commit]));
  const source = new R2ReviewSource(bucket);
  expect(await failureOf(() => source.readTree(commitId, ""))).toBe("not_found");
  expect(await failureOf(() => source.readFile(commitId, "gone.txt"))).toBe("not_found");
});
