import { expect, test } from "vitest";
import {
  buildPack,
  getObject,
  gitObjectId,
  headObject,
  listObjects,
  objectKey,
  putObject,
  uploadCheckpointPack,
} from "./objects.ts";
import type {
  GitObject,
  ObjectBody,
  ObjectBucket,
  ObjectListOptions,
  ObjectListPage,
  ObjectMetadata,
} from "./objects.ts";

const enc = new TextEncoder();
const bytes = (text: string): Uint8Array => enc.encode(text);
const blob = (text: string): GitObject => ({ type: "blob", content: bytes(text) });
const commit = (text: string): GitObject => ({ type: "commit", content: bytes(text) });

/** An in-memory store with the object store methods this module calls. */
class FakeBucket implements ObjectBucket {
  readonly stored = new Map<string, Uint8Array>();
  readonly writes: string[] = [];
  /** When set, put waits for the promise before it stores anything. */
  gate: Promise<void> | undefined;
  /** When true, put reports the refusal R2 uses (null). */
  refuse = false;
  pageSize = 2;

  async put(key: string, value: Uint8Array): Promise<{ key: string } | null> {
    this.writes.push(key);
    if (this.gate !== undefined) await this.gate;
    if (this.refuse) return null;
    this.stored.set(key, value);
    return { key };
  }

  async get(key: string): Promise<ObjectBody | null> {
    const value = this.stored.get(key);
    if (value === undefined) return null;
    return { arrayBuffer: async () => new Uint8Array(value).buffer };
  }

  async head(key: string): Promise<ObjectMetadata | null> {
    const value = this.stored.get(key);
    return value === undefined ? null : { key, size: value.length };
  }

  async list(options?: ObjectListOptions): Promise<ObjectListPage> {
    const prefix = options?.prefix ?? "";
    const entries = [...this.stored.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const start = options?.cursor === undefined ? 0 : Number(options.cursor);
    const end = start + this.pageSize;
    const objects = entries.slice(start, end).map(([key, value]) => ({ key, size: value.length }));
    return end < entries.length
      ? { objects, truncated: true, cursor: String(end) }
      : { objects, truncated: false };
  }
}

/** Wait until the condition holds, so a test never sleeps to synchronize. */
const until = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) await Promise.resolve();
};

// Catches: a header that hashes the content without git\u2019s "<type> <length>\0" prefix.
test("hashes an object exactly as git does", async () => {
  expect(await gitObjectId(blob(""))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  expect(await gitObjectId(blob("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  expect(await gitObjectId(blob("hello world"))).toBe("95d09f2b10159347eece71399a7e2e907ea3df4f");
  const checkpoint =
    "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n" +
    "author hns <hns@example.com> 1700000000 +0000\n" +
    "committer hns <hns@example.com> 1700000000 +0000\n" +
    "\n" +
    "checkpoint\n";
  expect(await gitObjectId(commit(checkpoint))).toBe("1c8a0eb11c68ea88842c48eefb22190531668110");
  // The type is part of the hash: the same bytes as a tree are a different object.
  expect(await gitObjectId({ type: "tree", content: bytes("hello\n") })).not.toBe(
    await gitObjectId(blob("hello\n")),
  );
});

// Catches: a second put of the same content writing the same key again.
test("writes the same content to the bucket once", async () => {
  const bucket = new FakeBucket();
  const id = await putObject(bucket, blob("hello\n"));
  expect(await putObject(bucket, blob("hello\n"))).toBe(id);
  expect(bucket.writes).toStrictEqual([objectKey(id)]);
  expect([...bucket.stored.keys()]).toStrictEqual([objectKey(id)]);
});

// Catches: resolving the caller before the store accepted the bytes (an early ack).
test("a put resolves only after the bucket accepted it", async () => {
  const bucket = new FakeBucket();
  let release: (() => void) | undefined;
  bucket.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settled = false;
  const pending = putObject(bucket, blob("hello\n")).then((id) => {
    settled = true;
    return id;
  });
  await until(() => bucket.writes.length > 0);
  expect(settled).toBe(false);
  release?.();
  expect(await pending).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  expect(settled).toBe(true);
});

// Catches: treating a refused write (null) as stored.
test("throws when the bucket refuses a write", async () => {
  const bucket = new FakeBucket();
  bucket.refuse = true;
  await expect(putObject(bucket, blob("hello\n"))).rejects.toThrow(/refused/u);
  expect(bucket.stored.size).toBe(0);
});

// Catches: a get or head that returns a body for an id the store does not have.
test("reads back stored objects and reports a missing id as null", async () => {
  const bucket = new FakeBucket();
  const id = await putObject(bucket, blob("hello\n"));
  expect(await getObject(bucket, id)).toStrictEqual(bytes("blob 6\0hello\n"));
  expect(await headObject(bucket, id)).toStrictEqual({ key: objectKey(id), size: 13 });
  expect(await getObject(bucket, "0".repeat(40))).toBeNull();
  expect(await headObject(bucket, "0".repeat(40))).toBeNull();
});

// Catches: a listing that stops at the first page.
test("follows the cursor when the bucket pages a listing", async () => {
  const bucket = new FakeBucket();
  const ids = await Promise.all([
    putObject(bucket, blob("one")),
    putObject(bucket, blob("two")),
    putObject(bucket, blob("three")),
  ]);
  const keys = await listObjects(bucket);
  expect(keys).toHaveLength(3);
  expect(keys.sort()).toStrictEqual(ids.map(objectKey).sort());
});

// Catches: packing in insertion order, so retries upload different bytes.
test("builds the same pack from any order of the same objects", async () => {
  const objects = [blob("one"), blob("two"), commit("checkpoint")];
  const forward = await buildPack(objects);
  const reverse = await buildPack([...objects].reverse());
  expect(reverse.bytes).toStrictEqual(forward.bytes);
  expect(reverse.objects).toStrictEqual(forward.objects);
});

// Catches: a pack that stores the same object twice.
test("packs one entry per distinct object", async () => {
  const pack = await buildPack([blob("one"), blob("one"), blob("two")]);
  const view = new DataView(pack.bytes.buffer, pack.bytes.byteOffset, pack.bytes.byteLength);
  expect(view.getUint32(8)).toBe(2);
  expect(pack.objects.map((object) => object.id)).toStrictEqual([
    ...new Set(pack.objects.map((object) => object.id)),
  ]);
});

// Catches: a pack git rejects (wrong signature, version, count, or trailer).
test("stamps the pack with its version, count, and SHA-1 trailer", async () => {
  const pack = await buildPack([blob("hello\n")]);
  const view = new DataView(pack.bytes.buffer, pack.bytes.byteOffset, pack.bytes.byteLength);
  expect(new TextDecoder().decode(pack.bytes.subarray(0, 4))).toBe("PACK");
  expect(view.getUint32(4)).toBe(2);
  expect(view.getUint32(8)).toBe(1);
  const body = pack.bytes.slice(0, pack.bytes.length - 20);
  const trailer = pack.bytes.slice(pack.bytes.length - 20);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", body));
  expect(trailer).toStrictEqual(digest);
});

// Catches: a checkpoint that writes more than one pack, or a key not derived from the commit.
test("uploads one pack keyed by the checkpoint commit", async () => {
  const bucket = new FakeBucket();
  const checkpoint = commit("checkpoint");
  const objects = [blob("hello\n"), checkpoint];
  const id = await gitObjectId(checkpoint);
  const first = await uploadCheckpointPack(bucket, objects);
  expect(first).toStrictEqual({ commit: id, key: "checkpoints/" + id + ".pack", uploaded: true });
  expect(bucket.writes).toStrictEqual([first.key]);
  expect(await uploadCheckpointPack(bucket, objects)).toStrictEqual({ ...first, uploaded: false });
  expect(bucket.writes).toStrictEqual([first.key]);
});

// Catches: a checkpoint whose commit cannot be identified from the uploaded objects.
test("refuses a set that does not carry exactly one commit", async () => {
  const bucket = new FakeBucket();
  await expect(uploadCheckpointPack(bucket, [blob("hello\n")])).rejects.toThrow(
    /exactly one commit/u,
  );
  await expect(uploadCheckpointPack(bucket, [commit("one"), commit("two")])).rejects.toThrow(
    /exactly one commit/u,
  );
  expect(bucket.writes).toStrictEqual([]);
});
