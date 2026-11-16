/**
 * Content-addressed git objects in an object store (R2 on the edge).
 *
 * @remarks
 * Keys are git object ids, so storing the same content twice is a no-op: the id
 * is derived from the type and the bytes, not from the file or the run. The
 * module stays runtime-neutral (Web Crypto and `CompressionStream`) because the
 * same code runs in Node (checkpoint tests, the machine) and in workerd (the
 * Worker's R2 binding).
 *
 * A checkpoint is one pack: build the objects reachable from the commit, upload
 * them as a single git v2 pack keyed by the commit, and let restore index it.
 * `docs/durability.md` §5 is the contract; this module is the mechanism.
 */

/** The four object types a git pack can carry. */
export const GIT_OBJECT_TYPES = ["blob", "tree", "commit", "tag"] as const;

/** One object type a git pack can carry. */
export type GitObjectType = (typeof GIT_OBJECT_TYPES)[number];

/** One raw git object: its type and its content, before the git header. */
export interface GitObject {
  readonly type: GitObjectType;
  readonly content: Uint8Array;
}

/** An object's metadata, as much as this module reads from the store. */
export interface ObjectMetadata {
  readonly key: string;
  readonly size: number;
}

/** An object's body, narrowed to the one method this module calls. */
export interface ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** What a successful write returns; `null` from `put` means the store refused it. */
export interface StoredObject {
  readonly key: string;
}

/** How far a listing page goes; the fields are R2's list options. */
export interface ObjectListOptions {
  readonly prefix?: string | undefined;
  readonly cursor?: string | undefined;
}

/** One page of a listing. `cursor` is present exactly when `truncated` is true. */
export interface ObjectListPage {
  readonly objects: readonly ObjectMetadata[];
  readonly truncated: boolean;
  readonly cursor?: string | undefined;
}

/**
 * The object store this module writes to, structurally narrowed from R2.
 *
 * @remarks
 * `put` returns null when the store refused the write; callers must not treat
 * that as stored. Every method is awaited before the next step, so a caller that
 * returns to its own caller after `put` has the store's acknowledgement.
 */
export interface ObjectBucket {
  put(key: string, value: Uint8Array): Promise<StoredObject | null>;
  get(key: string): Promise<ObjectBody | null>;
  head(key: string): Promise<ObjectMetadata | null>;
  list(options?: ObjectListOptions): Promise<ObjectListPage>;
}

/** One object present in a pack, in pack order. */
export interface PackedObject {
  /** The git object id the pack stores it under. */
  readonly id: string;
  /** The type recorded in the pack entry. */
  readonly type: GitObjectType;
}

/** A built pack: the bytes to upload, and what they contain. */
export interface BuiltPack {
  /** The complete pack (header, entries, SHA-1 trailer). */
  readonly bytes: Uint8Array;
  /** The objects in the order they appear, one per distinct id. */
  readonly objects: readonly PackedObject[];
}

/** Where a checkpoint pack landed. */
export interface CheckpointPack {
  /** The commit the pack is keyed by; C in `(C, J)`. */
  readonly commit: string;
  /** The store key of the pack. */
  readonly key: string;
  /** False when the pack was already in the store, so no write was made. */
  readonly uploaded: boolean;
}

const enc = new TextEncoder();

/** git's pack type numbers: commit = 1, tree = 2, blob = 3, tag = 4. */
const PACK_TYPE: Record<GitObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};
const PACK_SIGNATURE = "PACK";
const PACK_VERSION = 2;
const OBJECT_PREFIX = "objects/";
const CHECKPOINT_PREFIX = "checkpoints/";
const PACK_SUFFIX = ".pack";

/**
 * The store key of one object.
 *
 * @param id - The git object id.
 * @returns `objects/<id>`; the same bytes always land on the same key.
 */
export const objectKey = (id: string): string => OBJECT_PREFIX + id;

/**
 * The store key of a checkpoint pack.
 *
 * @param commit - The checkpoint commit id (C).
 * @returns `checkpoints/<commit>.pack`; restore finds C's pack by this key.
 */
export const checkpointPackKey = (commit: string): string =>
  CHECKPOINT_PREFIX + commit + PACK_SUFFIX;

const hex = (bytes: Uint8Array): string => {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
};

/** SHA-1 of the bytes, as raw digest bytes. Inputs are always freshly allocated buffers. */
const sha1 = async (bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));

/** Concatenate without spread, so large objects do not blow the call stack. */
const concat = (parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** The bytes git hashes: `<type> <length>\0` followed by the content. */
const rawObject = (object: GitObject): Uint8Array<ArrayBuffer> =>
  concat([enc.encode(object.type + " " + String(object.content.length) + "\0"), object.content]);

/** zlib deflate, the form git stores object data in. */
const deflate = async (bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> => {
  const stream = new Blob([new Uint8Array(bytes)])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/**
 * The git object id of an object: `SHA-1("<type> <length>\0" + content)`.
 *
 * @param object - The object to identify.
 * @returns The id as lowercase hex, the same string git uses.
 */
export const gitObjectId = async (object: GitObject): Promise<string> =>
  hex(await sha1(rawObject(object)));

/** The variable-length entry header: 4 size bits + 3 type bits, then 7-bit size groups. */
const packEntryHeader = (type: GitObjectType, size: number): Uint8Array => {
  const bytes: number[] = [];
  let remaining = size;
  let byte = (remaining % 16) | (PACK_TYPE[type] << 4);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(byte | 0x80);
    byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(byte);
  return Uint8Array.from(bytes);
};

/** The 12-byte pack header: signature, version, object count. */
const packHeader = (count: number): Uint8Array => {
  const bytes = new Uint8Array(12);
  bytes.set(enc.encode(PACK_SIGNATURE), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, PACK_VERSION);
  view.setUint32(8, count);
  return bytes;
};

/**
 * Build one git v2 pack from a set of objects.
 *
 * @param objects - The objects to pack; duplicates are collapsed by id.
 * @returns The pack bytes and its objects in sorted id order.
 * @throws When the set is empty. git and the checkpoint both need at least one object.
 *
 * @remarks
 * The order is sorted by object id, so the same set produces the same bytes no
 * matter how the caller collected it. The trailer is the SHA-1 of everything
 * before it, which is what `git index-pack` checks.
 */
export const buildPack = async (objects: readonly GitObject[]): Promise<BuiltPack> => {
  if (objects.length === 0) throw new Error("a pack needs at least one object");
  const distinct = new Map<string, GitObject>();
  for (const object of objects) {
    const id = await gitObjectId(object);
    if (!distinct.has(id)) distinct.set(id, object);
  }
  const ordered = [...distinct.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const parts: Uint8Array[] = [packHeader(ordered.length)];
  for (const [, object] of ordered) {
    // A pack entry carries the content only; git adds the "<type> <size>\0" header itself.
    parts.push(packEntryHeader(object.type, object.content.length));
    parts.push(await deflate(object.content));
  }
  const body = concat(parts);
  return {
    bytes: concat([body, await sha1(body)]),
    objects: ordered.map(([id, object]) => ({ id, type: object.type })),
  };
};

/**
 * Store one object, unless the same content is already there.
 *
 * @param bucket - The object store.
 * @param object - The object to store.
 * @returns The git object id the object is keyed by.
 * @throws When the store refuses the write (its `put` returns null).
 *
 * @remarks
 * The existence check is the deduplication: the key is derived from the content,
 * so a second write of the same content would overwrite identical bytes.
 * A throw after the store accepted the bytes is not possible here: the returned
 * promise resolves only after `put` resolved (the ack ordering in
 * `docs/durability.md` §3.1).
 */
export const putObject = async (bucket: ObjectBucket, object: GitObject): Promise<string> => {
  const id = await gitObjectId(object);
  const key = objectKey(id);
  if ((await bucket.head(key)) !== null) return id;
  const stored = await bucket.put(key, rawObject(object));
  if (stored === null) throw new Error("the object store refused " + key);
  return id;
};

/**
 * Read one object back.
 *
 * @param bucket - The object store.
 * @param id - The git object id.
 * @returns The raw object bytes, or null when the store has no such id.
 */
export const getObject = async (bucket: ObjectBucket, id: string): Promise<Uint8Array | null> => {
  const body = await bucket.get(objectKey(id));
  if (body === null) return null;
  return new Uint8Array(await body.arrayBuffer());
};

/**
 * Report whether an object is stored, and how large it is.
 *
 * @param bucket - The object store.
 * @param id - The git object id.
 * @returns The stored metadata, or null when absent.
 */
export const headObject = async (
  bucket: ObjectBucket,
  id: string,
): Promise<ObjectMetadata | null> => await bucket.head(objectKey(id));

/**
 * List every stored object key.
 *
 * @param bucket - The object store.
 * @returns The `objects/<id>` keys, across every page.
 * @throws When the store reports a truncated page without a cursor, which would
 * otherwise loop forever.
 */
export const listObjects = async (bucket: ObjectBucket): Promise<string[]> => {
  let page = await bucket.list({ prefix: OBJECT_PREFIX });
  const keys = page.objects.map((object) => object.key);
  while (page.truncated) {
    if (page.cursor === undefined) {
      throw new Error("the object store reported a truncated listing without a cursor");
    }
    page = await bucket.list({ prefix: OBJECT_PREFIX, cursor: page.cursor });
    keys.push(...page.objects.map((object) => object.key));
  }
  return keys;
};

/**
 * Upload a checkpoint as one pack, keyed by its commit.
 *
 * @param bucket - The object store.
 * @param objects - Every object reachable from the checkpoint commit.
 * @returns The commit, the key, and whether this call wrote the pack.
 * @throws When the set does not carry exactly one distinct commit, or when the
 * store refuses the write.
 *
 * @remarks
 * One checkpoint is one Class A write: the pack is uploaded once and the
 * existence check makes a retried checkpoint a no-op instead of a second write.
 * The commit must be in the set, because the key is derived from it and restore
 * finds the pack by C.
 *
 * The caller must pass the complete closure reachable from the commit. A retry
 * trusts that the pack already at the key was built from that closure; restore
 * verifies it by indexing the pack, so an incomplete closure fails there instead
 * of being silently accepted.
 */
export const uploadCheckpointPack = async (
  bucket: ObjectBucket,
  objects: readonly GitObject[],
): Promise<CheckpointPack> => {
  const commitIds = new Set<string>();
  for (const object of objects) {
    if (object.type === "commit") commitIds.add(await gitObjectId(object));
  }
  const [commit] = [...commitIds];
  if (commit === undefined || commitIds.size > 1) {
    throw new Error("a checkpoint needs exactly one commit, got " + String(commitIds.size));
  }
  const key = checkpointPackKey(commit);
  if ((await bucket.head(key)) !== null) return { commit, key, uploaded: false };
  const pack = await buildPack(objects);
  const stored = await bucket.put(key, pack.bytes);
  if (stored === null) throw new Error("the object store refused " + key);
  return { commit, key, uploaded: true };
};

/**
 * Read a checkpoint pack back.
 *
 * @param bucket - The object store.
 * @param commit - The checkpoint commit id (C).
 * @returns The pack bytes, or null when the checkpoint was never uploaded.
 */
export const readCheckpointPack = async (
  bucket: ObjectBucket,
  commit: string,
): Promise<Uint8Array | null> => {
  const body = await bucket.get(checkpointPackKey(commit));
  if (body === null) return null;
  return new Uint8Array(await body.arrayBuffer());
};
