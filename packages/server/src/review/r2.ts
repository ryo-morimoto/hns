import { isoTimestamp } from "@hns/core";
import type { IsoTimestamp } from "@hns/core";
import type { ReviewCommit, ReviewFile, ReviewTreeEntry, ReviewTreeEntryMode } from "@hns/core";
import { checkpointPackKey } from "@hns/workspace/objects";
import type { ObjectBody } from "@hns/workspace/objects";
import { PackFormatError, openPack } from "@hns/workspace/pack";
import type { OpenPack, PackLimits } from "@hns/workspace/pack";
import { ReviewSourceError } from "./source.ts";
import type { ReviewSource } from "./source.ts";

/**
 * The part of the object store a review reads: the Worker's `OBJECTS` binding, structurally.
 *
 * @remarks
 * `get` answers the bytes, or null when the key is absent. A binding that throws is a defect of the
 * store, not a review failure; the adapter does not swallow it.
 */
export interface ReviewBucket {
  get(key: string): Promise<ObjectBody | null>;
}

/** How much a review may read from one pack and one file. */
export interface ReviewLimits {
  /** The pack reader's bound; the pack itself is checked against it before it is opened. */
  readonly pack: PackLimits;
  /** The largest file `readFile` answers; a larger blob is `too_large`. */
  readonly maxFileBytes: number;
}

/** The largest file a review shows by default; over it the caller gets `too_large`. */
export const REVIEW_MAX_FILE_BYTES = 32 * 1024 * 1024;

const COMMIT_ID = /^[0-9a-f]{40}$/u;
const dec = new TextDecoder();
/** The bytes of a raw git object id in a tree entry. */
const OBJECT_ID_BYTES = 20;

/** A tree entry as the tree object stores it: a mode, a name, and a 20-byte object id. */
interface RawTreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly object: string;
}

/**
 * What a tree entry's mode names.
 *
 * @remarks
 * A review distinguishes a symlink from a file: a symlink's blob is the link target, and showing
 * it as file content would make a link look like the file it points at. A submodule (`160000`) is a
 * commit in another repository, which this pack does not carry.
 */
export type ReviewEntryKind = "blob" | "tree" | "commit" | "symlink";

/** The git mode that makes an entry a symlink. */
const SYMLINK_MODE = "120000";
/** The git mode that makes an entry a submodule. */
const GITLINK_MODE = "160000";
/** The git mode that makes an entry a directory. */
const TREE_MODES: ReadonlySet<string> = new Set(["40000", "040000"]);

/** git writes the tree mode without its leading zero; the contract spells it `40000`. */
const normaliseMode = (mode: string): ReviewTreeEntryMode => {
  const normalised = mode === "040000" ? "40000" : mode;
  // SAFETY: parseTree only reaches this for a mode kindOfMode accepts, and those are exactly the
  // modes the contract lists; the cast names that set for the compiler.
  return normalised as ReviewTreeEntryMode;
};

/** The kind a tree mode names, or undefined for a mode a review does not read. */
const kindOfMode = (mode: string): ReviewEntryKind | undefined => {
  if (TREE_MODES.has(mode)) return "tree";
  if (mode === SYMLINK_MODE) return "symlink";
  if (mode === GITLINK_MODE) return "commit";
  // Executable and regular blobs are both files; git writes 100755 for an executable.
  if (mode === "100644" || mode === "100755") return "blob";
  return undefined;
};

/** The tree object's bytes as entries. */
const parseTree = (content: Uint8Array): readonly RawTreeEntry[] => {
  const entries: RawTreeEntry[] = [];
  let at = 0;
  while (at < content.length) {
    const space = content.indexOf(0x20, at);
    const nul = content.indexOf(0x00, space + 1);
    if (space === -1 || nul === -1 || nul + 1 + OBJECT_ID_BYTES > content.length) {
      throw new ReviewSourceError("unavailable", "a tree object is malformed");
    }
    const mode = dec.decode(content.subarray(at, space));
    const name = dec.decode(content.subarray(space + 1, nul));
    let object = "";
    for (const byte of content.subarray(nul + 1, nul + 1 + OBJECT_ID_BYTES)) {
      object += byte.toString(16).padStart(2, "0");
    }
    entries.push({ mode, name, object });
    at = nul + 1 + OBJECT_ID_BYTES;
  }
  return entries;
};

/**
 * The commit object's bytes as a review reads them.
 *
 * @param id - The commit id the caller asked for, which the value carries.
 * @param content - The commit object's stored bytes.
 * @returns The commit, its root tree, its message, and its committer time.
 * @throws {@link ReviewSourceError} `unavailable` when a commit object cannot be read.
 *
 * @remarks
 * A commit object is `tree <id>`, `parent <id>` lines, `author` and `committer` lines, a blank
 * line, and the message. A checkpoint commit has no parent, but the parse does not rely on that:
 * it reads the fields a review names and ignores the rest.
 */
const parseCommit = (id: string, content: Uint8Array): ReviewCommit => {
  const text = dec.decode(content);
  const headerEnd = text.indexOf("\n\n");
  const headers = headerEnd === -1 ? text : text.slice(0, headerEnd);
  const message = headerEnd === -1 ? "" : text.slice(headerEnd + 2);
  let tree = "";
  let committedAt: IsoTimestamp | undefined;
  for (const line of headers.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5);
    if (line.startsWith("committer ")) {
      // `<name> <email> <seconds> <offset>`; the seconds are the commit time.
      const parts = line.split(" ");
      const seconds = Number(parts[parts.length - 2]);
      if (Number.isSafeInteger(seconds)) {
        committedAt = isoTimestamp(new Date(seconds * 1000).toISOString());
      }
    }
  }
  if (!COMMIT_ID.test(tree) || committedAt === undefined) {
    throw new ReviewSourceError("unavailable", "a commit object is malformed");
  }
  return { commit: id, tree, message, committedAt };
};

/** A content type hint from a path's extension; a generic stream when the extension is unknown. */
const contentTypeOf = (path: string): string => {
  const dot = path.lastIndexOf(".");
  const extension = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  const known: ReadonlyMap<string, string> = new Map([
    ["ts", "text/plain"],
    ["tsx", "text/plain"],
    ["js", "text/plain"],
    ["mjs", "text/plain"],
    ["json", "application/json"],
    ["md", "text/markdown"],
    ["css", "text/css"],
    ["html", "text/html"],
    ["txt", "text/plain"],
    ["yml", "text/yaml"],
    ["yaml", "text/yaml"],
    ["toml", "text/plain"],
    ["lock", "text/plain"],
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
    ["svg", "image/svg+xml"],
    ["pdf", "application/pdf"],
  ]);
  return known.get(extension) ?? "application/octet-stream";
};

/** The default bounds: the pack reader's own limits and a 32 MiB file. */
export const REVIEW_LIMITS: ReviewLimits = {
  pack: { maxPackBytes: 64 * 1024 * 1024, maxObjects: 1024 * 1024, maxDeltaDepth: 50 },
  maxFileBytes: REVIEW_MAX_FILE_BYTES,
};

/**
 * The review source over R2: the checkpoint packs a machine wrote, read without git.
 *
 * @remarks
 * A checkpoint is one pack at `checkpoints/<commit>.pack` (`@hns/workspace/objects`), and that
 * pack carries the whole closure of the commit, so `log`, `readTree`, and `readFile` read the pack
 * and never a ref, a mirror, or a machine. The first read of a commit opens its pack and keeps
 * it, so a review of one commit inflates once however many directories and files it walks.
 *
 * Failures are {@link ReviewSourceError} with a code from `REVIEW_FAILURES`: a commit without a
 * pack is `not_found`; a pack or object the reader cannot parse is `unavailable` (the pack is
 * there but does not hold what its key claims); a path that leaves the tree is `invalid_request`;
 * and a pack or file over the limits is `too_large`. A store that throws is a defect and
 * propagates; a store that answers null is an absent key, which is `not_found`.
 */
export class R2ReviewSource implements ReviewSource {
  readonly #bucket: ReviewBucket;
  readonly #limits: ReviewLimits;
  readonly #packs = new Map<string, OpenPack>();

  /**
   * @param bucket - The Worker's `OBJECTS` binding, structurally.
   * @param limits - The bounds on one pack and one file; defaults to {@link REVIEW_LIMITS}.
   */
  constructor(bucket: ReviewBucket, limits: ReviewLimits = REVIEW_LIMITS) {
    this.#bucket = bucket;
    this.#limits = limits;
  }

  /** Check a caller's commit id before it becomes a store key. */
  static #commitId(commit: string): string {
    if (!COMMIT_ID.test(commit)) {
      throw new ReviewSourceError("invalid_request", "not a commit id: " + JSON.stringify(commit));
    }
    return commit;
  }

  /** Reject a path that leaves the tree, with the rule the port's fake uses. */
  static #checkPath(path: string): void {
    if (
      path.includes("\0") ||
      path.startsWith("/") ||
      path.split("/").some((segment) => segment === ".." || segment === ".") ||
      path.includes("//")
    ) {
      throw new ReviewSourceError(
        "invalid_request",
        "path leaves the tree: " + JSON.stringify(path),
      );
    }
  }

  /** The commit's pack, opened once per source. */
  async #pack(commit: string): Promise<OpenPack> {
    const memoized = this.#packs.get(commit);
    if (memoized !== undefined) return memoized;
    const body = await this.#bucket.get(checkpointPackKey(commit));
    if (body === null) {
      throw new ReviewSourceError("not_found", "no checkpoint pack for " + commit);
    }
    const bytes = new Uint8Array(await body.arrayBuffer());
    if (bytes.length > this.#limits.pack.maxPackBytes) {
      throw new ReviewSourceError(
        "too_large",
        "the checkpoint pack of " + commit + " is too large",
      );
    }
    let pack: OpenPack;
    try {
      pack = await openPack(bytes, this.#limits.pack);
    } catch (cause) {
      if (cause instanceof PackFormatError) {
        throw new ReviewSourceError(
          "unavailable",
          "the checkpoint pack of " + commit + " cannot be read: " + cause.message,
        );
      }
      throw cause;
    }
    this.#packs.set(commit, pack);
    return pack;
  }

  /** The object an id names, or `not_found` when the pack does not carry it. */
  #object(
    pack: OpenPack,
    id: string,
    what: string,
  ): { readonly type: string; readonly content: Uint8Array } {
    const object = pack.getObject(id);
    if (object === null) {
      throw new ReviewSourceError("not_found", "the pack does not carry " + what);
    }
    return object;
  }

  /** The commit object for an id, with the pack already open. */
  #commit(pack: OpenPack, id: string): ReviewCommit {
    const object = this.#object(pack, id, "commit " + id);
    if (object.type !== "commit") {
      throw new ReviewSourceError("not_found", id + " is not a commit");
    }
    return parseCommit(id, object.content);
  }

  /** Walk `path` from the root tree one directory at a time; `""` answers the root. */
  #walk(pack: OpenPack, root: string, path: string): RawTreeEntry {
    let treeId = root;
    let entry: RawTreeEntry | undefined;
    const segments = path === "" ? [] : path.split("/");
    for (const [index, segment] of segments.entries()) {
      const object = this.#object(pack, treeId, "tree " + treeId);
      if (object.type !== "tree") {
        throw new ReviewSourceError("not_found", JSON.stringify(path) + " is not a directory");
      }
      entry = parseTree(object.content).find((candidate) => candidate.name === segment);
      if (entry === undefined) {
        throw new ReviewSourceError("not_found", "no " + JSON.stringify(path) + " in the tree");
      }
      // Only the segments that still have to be descended need to be directories. The last one is
      // the entry the caller asked for, whatever it is: a symlink answers its target as a file and
      // is never followed, and a submodule is a commit in another repository the pack does not
      // carry. Every earlier segment is a directory or the walk cannot continue.
      if (index === segments.length - 1) {
        const kind = kindOfMode(entry.mode);
        if (kind === "commit") {
          throw new ReviewSourceError("not_found", JSON.stringify(path) + " is a submodule");
        }
        return entry;
      }
      if (kindOfMode(entry.mode) !== "tree") {
        throw new ReviewSourceError(
          "not_found",
          JSON.stringify(path) + " is not inside a directory at " + JSON.stringify(segment),
        );
      }
      treeId = entry.object;
    }
    return { mode: "040000", name: "", object: root };
  }

  async log(commit: string): Promise<ReviewCommit> {
    const id = R2ReviewSource.#commitId(commit);
    const pack = await this.#pack(id);
    return this.#commit(pack, id);
  }

  async readTree(commit: string, path: string): Promise<readonly ReviewTreeEntry[]> {
    const id = R2ReviewSource.#commitId(commit);
    R2ReviewSource.#checkPath(path);
    const pack = await this.#pack(id);
    const tree = this.#walk(pack, this.#commit(pack, id).tree, path);
    const object = this.#object(pack, tree.object, "tree " + tree.object);
    if (object.type !== "tree") {
      throw new ReviewSourceError("not_found", JSON.stringify(path) + " is not a directory");
    }
    // One directory, in the tree's own order. A blob's size is its stored content; a tree has no
    // bytes of its own that a reviewer measures, so its size is 0.
    const entries: ReviewTreeEntry[] = [];
    for (const entry of parseTree(object.content)) {
      const kind = kindOfMode(entry.mode);
      if (kind === undefined) {
        throw new ReviewSourceError("unavailable", "a tree entry has a mode a review cannot read");
      }
      const size =
        kind === "blob" || kind === "symlink"
          ? this.#object(pack, entry.object, "blob " + entry.object).content.length
          : 0;
      // A symlink is a blob in the contract's kind vocabulary (its bytes are the link target); the
      // mode is what tells it apart. A submodule is a commit in another repository, which this pack
      // does not carry.
      entries.push({
        path: entry.name,
        kind: kind === "symlink" ? "blob" : kind,
        mode: normaliseMode(entry.mode),
        object: entry.object,
        size,
      });
    }
    return entries;
  }

  async readFile(commit: string, path: string): Promise<ReviewFile> {
    const id = R2ReviewSource.#commitId(commit);
    R2ReviewSource.#checkPath(path);
    if (path === "") {
      throw new ReviewSourceError("invalid_request", "a file read needs a path");
    }
    const pack = await this.#pack(id);
    const entry = this.#walk(pack, this.#commit(pack, id).tree, path);
    const kind = kindOfMode(entry.mode);
    if (kind === "tree") {
      throw new ReviewSourceError("not_found", JSON.stringify(path) + " is a directory");
    }
    if (kind === "commit") {
      throw new ReviewSourceError("not_found", JSON.stringify(path) + " is a submodule");
    }
    const object = this.#object(pack, entry.object, "blob " + entry.object);
    if (object.type !== "blob") {
      throw new ReviewSourceError("not_found", JSON.stringify(path) + " is not a file");
    }
    if (object.content.length > this.#limits.maxFileBytes) {
      throw new ReviewSourceError("too_large", JSON.stringify(path) + " is too large to show");
    }
    // A symlink answers its link target: that is the bytes the tree stores, and the caller can see
    // from `readTree` that the entry is not a file.
    return { path, object: entry.object, contentType: contentTypeOf(path), bytes: object.content };
  }
}
