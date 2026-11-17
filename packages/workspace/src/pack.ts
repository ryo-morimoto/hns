/**
 * Read a git pack without git: index its entries, undo deltas, and verify every object id.
 *
 * @remarks
 * A checkpoint is one pack (`uploadCheckpointPack` in {@link ./objects.ts}), and both a restore on
 * a machine and a review in the Worker read that pack back. The reader lives here rather than in
 * `@hns/server` because both read the same bytes and the dependency runs server → workspace; a
 * Worker has no `child_process`, so this module does the read half of `git index-pack`: walk the
 * entry headers, inflate each entry (`zlib` deflate, the form a pack stores), apply
 * `ofs-delta` / `ref-delta` chains, and recompute `SHA-1("<type> <length>\0" + content)` for every
 * object. An object whose bytes do not hash to the id the pack names it by is not returned: a pack
 * that disagrees with its own ids is corrupt, not a source of bytes.
 *
 * The module is synchronous on purpose. `DecompressionStream` would make opening a pack an async
 * pipeline of one stream per object, bounded by the Worker's stream budget; `node:zlib`'s
 * `inflateSync` is the same API under Workers' `nodejs_compat` and resolves an object with no
 * scheduling between its header and its content. Because it imports `node:zlib`, it is a subpath
 * entry (`@hns/workspace/pack`), not part of the package root that the browser-facing code reads.
 */

import { inflateSync } from "node:zlib";
import type { GitObject, GitObjectType } from "./objects.ts";

/** A pack a reader refuses: not a well-formed pack, or not the pack its ids claim. */
export class PackFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackFormatError";
  }
}

/** One pack opened for reading. */
export interface OpenPack {
  /** The git object ids the pack carries, in pack order. */
  readonly ids: readonly string[];

  /**
   * The object with this id, or null when the pack does not carry it.
   *
   * @param id - A git object id (40 lowercase hex characters).
   * @returns The object's type and raw content, with every delta applied.
   * @throws {@link PackFormatError} when the pack cannot be read or a delta cannot be applied.
   */
  getObject(id: string): GitObject | null;
}

const PACK_SIGNATURE = "PACK";
const PACK_VERSION = 2;
const HEADER_BYTES = 12;
const TRAILER_BYTES = 20;
/** Pack entry type numbers: 1 commit, 2 tree, 3 blob, 4 tag; 6 ofs-delta, 7 ref-delta. */
const TYPE_OFS_DELTA = 6;
const TYPE_REF_DELTA = 7;

/** The git object type a pack type number names (1-4); a delta's type is 6 or 7. */
const typeOfNumber = (type: number): GitObjectType | undefined => {
  switch (type) {
    case 1:
      return "commit";
    case 2:
      return "tree";
    case 3:
      return "blob";
    case 4:
      return "tag";
    default:
      return undefined;
  }
};
const enc = new TextEncoder();

/**
 * The bound one pack may reach before a reader refuses it.
 *
 * @remarks
 * A pack is external input: it arrives from a machine and sits in R2, and nothing about its header
 * is trustworthy before it is read. These bounds are what keeps a hostile or corrupt pack from
 * turning into unbounded memory or an unbounded delta chain. They are generous against what a
 * checkpoint actually produces: a checkpoint pack is at most 64 MiB and its objects are one
 * closure of commits (git itself caps delta depth at 50).
 */
export interface PackLimits {
  /** The largest pack, in bytes, this reader opens; over it is `PackFormatError`. */
  readonly maxPackBytes: number;
  /** The most entries a pack may declare; over it is `PackFormatError`. */
  readonly maxObjects: number;
  /** The deepest delta chain a single object may need; over it is `PackFormatError`. */
  readonly maxDeltaDepth: number;
}

/** The limits a checkpoint pack is read under: 64 MiB, 2^20 objects, delta depth 50. */
export const DEFAULT_PACK_LIMITS: PackLimits = {
  maxPackBytes: 64 * 1024 * 1024,
  maxObjects: 1024 * 1024,
  maxDeltaDepth: 50,
};

/** SHA-1 of the bytes, as lowercase hex. Inputs are freshly allocated buffers. */
const sha1Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  let out = "";
  for (const byte of digest) out += byte.toString(16).padStart(2, "0");
  return out;
};

/** The bytes git hashes: `<type> <length>\0` followed by the content. */
const rawObject = async (
  type: GitObjectType,
  content: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> => {
  const header = enc.encode(type + " " + String(content.length) + "\0");
  const out = new Uint8Array(header.length + content.length);
  out.set(header, 0);
  out.set(content, header.length);
  return out;
};

/** One entry's decoded header, and where its zlib stream starts. */
interface EntryHeader {
  /** The pack type number: 1-4 for an object, 6 for ofs-delta, 7 for ref-delta. */
  readonly type: number;
  /** The inflated size the header declares (for a delta, the delta's size). */
  readonly size: number;
  /** For an ofs-delta, the distance back to the base entry's header offset. */
  readonly baseDistance: number;
  /** For a ref-delta, the base object's id. */
  readonly baseId: string;
  /** The first byte of the entry's zlib stream. */
  readonly dataOffset: number;
}

/** A variable-length size: 4 size bits in the first byte, then 7-bit groups. */
const readSize = (pack: Uint8Array, at: number, header: number): readonly [number, number] => {
  // The first byte's high bit says whether any group follows; when it does not, the size is its
  // low nibble alone and the next byte is already part of the stream.
  let size = header & 0x0f;
  if ((header & 0x80) === 0) return [size, at];
  let shift = 4;
  let index = at;
  for (;;) {
    const byte = pack[index];
    if (byte === undefined) throw new PackFormatError("a pack entry header ends inside its size");
    index += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) return [size, index];
    if (shift > 56) throw new PackFormatError("a pack entry size is too large to represent");
  }
};

/** An ofs-delta's base distance: big-endian base-128, with one added per continuation group. */
const readDistance = (pack: Uint8Array, at: number): readonly [number, number] => {
  let byte = pack[at];
  if (byte === undefined)
    throw new PackFormatError("an ofs-delta header ends inside its base offset");
  let index = at + 1;
  let distance = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    byte = pack[index];
    if (byte === undefined)
      throw new PackFormatError("an ofs-delta header ends inside its base offset");
    index += 1;
    distance = (distance + 1) * 128 + (byte & 0x7f);
  }
  return [distance, index];
};

/** Decode the entry header at `offset` in the pack. */
const readHeader = (pack: Uint8Array, offset: number): EntryHeader => {
  const first = pack[offset];
  if (first === undefined)
    throw new PackFormatError("a pack declares more entries than it carries");
  const type = (first >> 4) & 0x07;
  const [size, afterSize] = readSize(pack, offset + 1, first);
  if (type === TYPE_OFS_DELTA) {
    const [baseDistance, dataOffset] = readDistance(pack, afterSize);
    if (baseDistance === 0 || baseDistance > offset) {
      throw new PackFormatError("an ofs-delta names a base before the start of the pack");
    }
    return { type, size, baseDistance, baseId: "", dataOffset };
  }
  if (type === TYPE_REF_DELTA) {
    const end = afterSize + 20;
    if (end > pack.length) throw new PackFormatError("a ref-delta header ends inside its base id");
    let baseId = "";
    for (const byte of pack.subarray(afterSize, end)) baseId += byte.toString(16).padStart(2, "0");
    return { type, size, baseDistance: 0, baseId, dataOffset: end };
  }
  if (typeOfNumber(type) === undefined)
    throw new PackFormatError("a pack entry has an unknown type");
  return { type, size, baseDistance: 0, baseId: "", dataOffset: afterSize };
};

/**
 * Inflate the zlib stream starting at `offset`; answers its bytes and the first byte after it.
 *
 * @param pack - The pack, with its header checked.
 * @param offset - The first byte of the entry's zlib stream.
 * @param end - The first byte of the trailer; a stream never runs past it.
 * @returns The inflated bytes and the offset of the next header.
 * @throws {@link PackFormatError} when no complete stream starts at `offset`.
 *
 * @remarks
 * A pack does not record where a stream ends, so the stream is inflated over the rest of the pack
 * and `info` reports `engine.bytesWritten`, the input zlib consumed through the end of the stream
 * (including the zlib header and adler32 trailer). That figure is the stream's compressed length
 * and the next header starts right after it, so this is one inflate per entry and not a scan.
 * `bytesWritten` is only the stream's length when the stream ends inside the input, which is why
 * the whole remainder is given rather than a guess at the length.
 */

/** What `inflateSync(..., { info: true })` answers: the output and the input it consumed. */
interface InflateInfo {
  readonly buffer: Buffer<ArrayBuffer>;
  readonly engine: { readonly bytesWritten: number };
}

/**
 * Name the `info` shape of an inflate result.
 *
 * @param result - What `inflateSync` answered under `info: true`.
 * @returns The same value, typed as `{ buffer, engine }`.
 *
 * @remarks
 * `@types/node` declares `inflateSync` as returning a Buffer even under `info: true`, so the call
 * site cannot read `engine` without an assertion. The assertion lives here, once, with its reason,
 * and the call site gets a name. A node that answered a plain Buffer would make `engine`
 * `undefined`, which `inflateAt` refuses.
 */
const inflateInfo = (result: InflateInfo | Buffer): InflateInfo => {
  // SAFETY: node answers `{ buffer, engine }` when `info` is set; this is the documented shape.
  // The union lets the compiler narrow to `InflateInfo` once `engine` is present.
  if ("engine" in result) return result;
  throw new PackFormatError("zlib did not report the length of a pack entry");
};

const inflateAt = (
  pack: Uint8Array,
  offset: number,
  end: number,
): readonly [Uint8Array, number] => {
  let bytes: Buffer<ArrayBuffer>;
  let consumed: number;
  try {
    // `info` makes libuv report the input it consumed, which is the stream's length: the zlib
    // header, the deflate blocks, and the adler32 trailer. The type declarations describe the
    // answer only as the input type, so the `info` shape is named here.
    const result = inflateSync(new Uint8Array(pack.subarray(offset, end)), { info: true });
    // SAFETY: `info: true` is what makes node answer `{ buffer, engine }`; the overloads in
    // @types/node still declare only the plain Buffer return, so the answer is read through a
    // helper that names the shape once. If node ever answered a plain Buffer, `engine` would be
    // undefined and the check below refuses the entry rather than reading a wrong offset.
    const info = inflateInfo(result);
    bytes = info.buffer;
    consumed = info.engine.bytesWritten;
  } catch (cause) {
    throw new PackFormatError(
      "a pack entry's zlib stream is unreadable at " +
        String(offset) +
        ": " +
        (cause instanceof Error ? cause.message : "unknown"),
    );
  }
  if (!Number.isSafeInteger(consumed) || consumed <= 0 || offset + consumed > end) {
    throw new PackFormatError("a pack entry's zlib stream has no length at " + String(offset));
  }
  return [new Uint8Array(bytes), offset + consumed];
};
/** The size a delta's header declares, and the first byte after it. */
const readDeltaSize = (delta: Uint8Array, at: number): readonly [number, number] => {
  let size = 0;
  let shift = 0;
  let index = at;
  for (;;) {
    const byte = delta[index];
    if (byte === undefined) throw new PackFormatError("a delta header ends inside its size");
    index += 1;
    size += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [size, index];
    shift += 7;
    if (shift > 56) throw new PackFormatError("a delta size is too large to represent");
  }
};

/** Apply one git delta to its base, which must be exactly the base the delta names. */
const applyDelta = (base: Uint8Array, delta: Uint8Array): Uint8Array => {
  const [baseSize, afterBase] = readDeltaSize(delta, 0);
  if (baseSize !== base.length) {
    throw new PackFormatError(
      "a delta names a base of " +
        String(baseSize) +
        " bytes, but its base has " +
        String(base.length),
    );
  }
  const [resultSize, afterSize] = readDeltaSize(delta, afterBase);
  const out = new Uint8Array(resultSize);
  let cursor = 0;
  let index = afterSize;
  while (index < delta.length) {
    const opcode = delta[index];
    if (opcode === undefined) break;
    index += 1;
    if ((opcode & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((opcode & (1 << bit)) !== 0) {
          const byte = delta[index];
          if (byte === undefined) throw new PackFormatError("a delta copy ends inside its offset");
          copyOffset += byte * 2 ** (bit * 8);
          index += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((opcode & (1 << (4 + bit))) !== 0) {
          const byte = delta[index];
          if (byte === undefined) throw new PackFormatError("a delta copy ends inside its size");
          copySize += byte * 2 ** (bit * 8);
          index += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length || cursor + copySize > out.length) {
        throw new PackFormatError("a delta copy reaches outside its base or its result");
      }
      out.set(base.subarray(copyOffset, copyOffset + copySize), cursor);
      cursor += copySize;
    } else if (opcode === 0) {
      throw new PackFormatError("a delta has an opcode of zero");
    } else {
      if (index + opcode > delta.length || cursor + opcode > out.length) {
        throw new PackFormatError("a delta insertion reaches outside its result");
      }
      out.set(delta.subarray(index, index + opcode), cursor);
      cursor += opcode;
      index += opcode;
    }
  }
  if (cursor !== resultSize) {
    throw new PackFormatError(
      "a delta produced " +
        String(cursor) +
        " bytes, not the " +
        String(resultSize) +
        " it declares",
    );
  }
  return out;
};

/** One entry after indexing: where its header starts, its header, and its inflated stream. */
interface IndexedEntry {
  readonly offset: number;
  readonly header: EntryHeader;
  readonly inflated: Uint8Array;
}

/** The object an entry resolves to, after its deltas are applied. */
interface ResolvedObject {
  readonly type: GitObjectType;
  readonly content: Uint8Array;
}

/** A resolved object and how many deltas it needed, so a chain can be bounded. */
interface Resolved {
  readonly object: ResolvedObject;
  readonly depth: number;
}

/** Walk the headers and inflate every entry, in pack order. */
const indexEntries = (
  body: Uint8Array,
  count: number,
  limits: PackLimits,
): readonly IndexedEntry[] => {
  if (count > limits.maxObjects) {
    throw new PackFormatError(
      "a pack declares " +
        String(count) +
        " objects, over the limit of " +
        String(limits.maxObjects),
    );
  }
  const entries: IndexedEntry[] = [];
  let at = HEADER_BYTES;
  for (let position = 0; position < count; position += 1) {
    const header = readHeader(body, at);
    const [inflated, end] = inflateAt(body, header.dataOffset, body.length);
    if (end > body.length) throw new PackFormatError("a pack entry runs past the end of the pack");
    entries.push({ offset: at, header, inflated });
    at = end;
  }
  if (at !== body.length) {
    throw new PackFormatError("a pack carries bytes between its last entry and its trailer");
  }
  return entries;
};

/**
 * Resolve every entry into an object, applying deltas, and key the objects by their own id.
 *
 * @param entries - The indexed entries, in pack order.
 * @returns The objects by id, in first-appearance order.
 * @throws {@link PackFormatError} when a delta names a base the pack does not carry or cannot be
 * applied.
 *
 * @remarks
 * Three passes, so a delta never needs its base's id before the base exists: first every
 * non-delta entry and every ofs-delta (which names its base by position), then every ref-delta in
 * a loop that repeats while it makes progress (a ref-delta may name a base that is itself a
 * ref-delta). A pass that resolves nothing means a base is missing or the chain has a cycle;
 * both are corrupt packs.
 */
const resolveAll = async (
  entries: readonly IndexedEntry[],
  limits: PackLimits,
): Promise<ReadonlyMap<string, GitObject>> => {
  const byOffset = new Map<number, number>();
  entries.forEach((entry, position) => byOffset.set(entry.offset, position));
  const objects = new Map<string, GitObject>();
  const byPosition = new Map<number, Resolved>();
  // A ref-delta names its base by id, so the resolved objects are also keyed that way.
  const byId = new Map<string, Resolved>();
  const pending: number[] = [];

  /** Reject a delta chain deeper than the limit: a pack may not spend unbounded work per object. */
  const deeper = (base: number): number => {
    const depth = base + 1;
    if (depth > limits.maxDeltaDepth) {
      throw new PackFormatError(
        "a delta chain is deeper than the limit of " + String(limits.maxDeltaDepth),
      );
    }
    return depth;
  };

  const resolveOfs = (position: number): Resolved => {
    const entry = entries[position];
    if (entry === undefined)
      throw new PackFormatError("a delta names an entry the pack does not carry");
    const { header, inflated } = entry;
    const basePosition = byOffset.get(entry.offset - header.baseDistance);
    const base = basePosition === undefined ? undefined : byPosition.get(basePosition);
    if (base === undefined)
      throw new PackFormatError("an ofs-delta does not name an earlier entry");
    const depth = deeper(base.depth);
    const object: ResolvedObject = {
      type: base.object.type,
      content: applyDelta(base.object.content, inflated),
    };
    return { object, depth };
  };

  /** Record one resolved entry under its own id, and by position for a later delta. */
  const record = async (position: number, object: ResolvedObject, depth: number): Promise<void> => {
    byPosition.set(position, { object, depth });
    const id = await sha1Hex(await rawObject(object.type, object.content));
    byId.set(id, { object, depth });
    objects.set(id, { type: object.type, content: object.content });
  };

  for (const [position, entry] of entries.entries()) {
    const { header, inflated } = entry;
    if (header.type === TYPE_REF_DELTA) {
      pending.push(position);
    } else if (header.type === TYPE_OFS_DELTA) {
      const resolved = resolveOfs(position);
      await record(position, resolved.object, resolved.depth);
    } else {
      const type = typeOfNumber(header.type);
      if (type === undefined) throw new PackFormatError("a pack entry has an unknown type");
      if (inflated.length !== header.size) {
        throw new PackFormatError(
          "a pack entry declares " +
            String(header.size) +
            " bytes but inflates to " +
            String(inflated.length),
        );
      }
      await record(position, { type, content: inflated }, 0);
    }
  }

  let remaining = pending;
  while (remaining.length > 0) {
    const deferred: number[] = [];
    let progressed = false;
    for (const position of remaining) {
      const entry = entries[position];
      if (entry === undefined) throw new PackFormatError("a ref-delta names no entry");
      // A ref-delta names its base by id, and the id is only known after the base is resolved, so
      // each pass resolves whatever became known; a pass that resolves nothing means the base is
      // missing. The chain depth is carried with each resolved object for the same bound.
      const base = byId.get(entry.header.baseId);
      if (base === undefined) {
        deferred.push(position);
        continue;
      }
      const depth = deeper(base.depth);
      await record(
        position,
        { type: base.object.type, content: applyDelta(base.object.content, entry.inflated) },
        depth,
      );
      progressed = true;
    }
    if (!progressed) {
      throw new PackFormatError("a ref-delta names a base the pack does not carry");
    }
    remaining = deferred;
  }
  return objects;
};

/**
 * Index a pack and resolve every object in it.
 *
 * @param pack - The complete git v2 pack, including its 20-byte trailer.
 * @param limits - The bounds this read accepts; defaults to {@link DEFAULT_PACK_LIMITS}.
 * @returns A reader that answers objects by id.
 * @throws {@link PackFormatError} when the bytes are not a pack this module can read, when the
 * trailer is not the pack's SHA-1, or when an object's content does not hash to the id the pack
 * names it by.
 *
 * @remarks
 * Every entry is inflated once and memoized by position, so a delta chain is resolved once however
 * many objects share it. The trailer is checked first: a pack altered after it was written fails
 * here rather than answering different bytes under the same id.
 */
export const openPack = async (
  pack: Uint8Array,
  limits: PackLimits = DEFAULT_PACK_LIMITS,
): Promise<OpenPack> => {
  if (pack.length > limits.maxPackBytes) {
    throw new PackFormatError(
      "a pack of " +
        String(pack.length) +
        " bytes is over the limit of " +
        String(limits.maxPackBytes),
    );
  }
  if (pack.length < HEADER_BYTES + TRAILER_BYTES)
    throw new PackFormatError("a pack is shorter than a header");
  let signature = "";
  for (const byte of pack.subarray(0, 4)) signature += String.fromCharCode(byte);
  if (signature !== PACK_SIGNATURE) throw new PackFormatError("a pack does not start with PACK");
  const body = pack.subarray(0, pack.length - TRAILER_BYTES);
  let trailer = "";
  for (const byte of pack.subarray(pack.length - TRAILER_BYTES)) {
    trailer += byte.toString(16).padStart(2, "0");
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const version = view.getUint32(4);
  if (version !== PACK_VERSION)
    throw new PackFormatError("unsupported pack version " + String(version));
  if (trailer !== (await sha1Hex(new Uint8Array(body)))) {
    throw new PackFormatError("a pack's trailer is not the SHA-1 of its contents");
  }

  const entries = indexEntries(body, view.getUint32(8), limits);
  const objects = await resolveAll(entries, limits);
  return {
    ids: [...objects.keys()],
    getObject: (id: string): GitObject | null => objects.get(id) ?? null,
  };
};
