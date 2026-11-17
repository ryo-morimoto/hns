import { createHash, randomUUID } from "node:crypto";
import { FileError, getOrThrow } from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord";
import type {
  ExecutionEnv,
  FileChange,
  FileErrorCode,
  FileWatcher,
  Result,
} from "@earendil-works/pi-durable/env";
import { operationId } from "@hns/core";
import type { AbsentVersion, FileRead, MutationResult, OperationId } from "@hns/core";
import { Crash, Denied, FileFailure, Unavailable } from "./errors.ts";
import type { CrashPoint } from "./errors.ts";
import { emptyJournal, parseJournal } from "./journal.ts";
import { parseMarker } from "./protocol.ts";
import type { HelperOutcome } from "./protocol.ts";
import { Rooted } from "./rooted.ts";
import type {
  AuditEntry,
  FileEvent,
  FileEventDraft,
  JournalIntent,
  JournalState,
  Version,
} from "./types.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
/** Settled operations kept for replay; older ones are forgotten so the journal stays bounded. */
const DEFAULT_MAX_SETTLED_OPS = 500;

/**
 * Journal paths that an open Workspace in this process holds, as absolute paths.
 *
 * @remarks
 * A journal is one workspace's state: two workspaces saving it would each write
 * their own view over the other. The second open fails closed instead. The claim
 * is per process because that is what can be checked without a lease file a
 * crash would strand; sharing a journal across processes is outside the
 * guarantees in docs/workspace.md, and the per-save temp name keeps two
 * processes from writing the same temp file.
 */
const JOURNAL_CLAIMS = new Set<string>();

/**
 * The version of some bytes: their sha256, in the one spelling the workspace uses.
 *
 * @param bytes - The content to hash.
 * @returns `"sha256:<hex>"`, the same shape for a read and for a write, so a
 * caller can compare the two without knowing which produced it.
 */
const sha = (bytes: Uint8Array): Version =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");

if (import.meta.vitest) {
  const { expect, test } = import.meta.vitest;
  test("sha hashes empty content to the empty sha256", () => {
    expect(sha(new Uint8Array())).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
}

/**
 * ExecutionEnv reports file failures as FileError; the workspace speaks FileFailure.
 *
 * @param error - The error to translate.
 * @returns The same FileFailure, a FileFailure carrying the FileError code, or
 * the original error when it is neither. Other errors keep their identity, so a
 * caller still sees `Denied` or a programming error.
 */
function asFileFailure(error: Error): Error {
  if (error instanceof FileFailure) return error;
  if (error instanceof FileError) return new FileFailure(error.code, error.message);
  return error;
}

/**
 * Helper failure codes in pi-durable's vocabulary, so callers branch on code.
 *
 * @remarks
 * The helper's vocabulary is narrower than pi-durable's; `exists` and
 * `too_large` are reported as `invalid` because they mean "this request cannot
 * be honored as written", and `cross_device` and `io` as `unknown` because the
 * outcome is not decidable from the error alone.
 */
const HELPER_CODES = new Map<string, FileErrorCode>([
  ["not_found", "not_found"],
  ["not_directory", "not_directory"],
  ["is_directory", "is_directory"],
  ["invalid", "invalid"],
  ["permission_denied", "permission_denied"],
  ["exists", "invalid"],
  ["cross_device", "unknown"],
  ["too_large", "invalid"],
  ["io", "unknown"],
]);

/** One write. expectedVersion is required: the workspace refuses an unchecked replacement. */
export interface FileWrite {
  /**
   * The path relative to the root. Normalized before use: an absolute path, a
   * `..` segment, a NUL, or a drive letter is denied.
   */
  readonly path: string;
  /** UTF-8 text, or raw bytes when the caller already has them. */
  readonly content: string | Uint8Array;
  /**
   * The version the caller saw, or "absent" when it expects the name to be
   * free. A write that no longer matches returns a conflict instead of applying.
   */
  readonly expectedVersion: AbsentVersion;
  /**
   * The identity of one attempt. A replay with the same id returns the recorded
   * outcome; the same id with different content or `expectedVersion` is denied.
   */
  readonly operationId: string;
}

/** How to open a Workspace: the environment, the root, and the journal location. */
export interface WorkspaceOptions {
  /** Every file access goes through this environment; the workspace opens no file itself. */
  readonly env: ExecutionEnv;
  /** The managed directory. Canonicalized once at open and pinned for the workspace's life. */
  readonly root: string;
  /** Outside the root; the journal is not part of the workspace tree. */
  readonly journalPath: string;
  /** The execution context passed to every environment call. */
  readonly context: Context;
  /** Test hook: stop the write at a crash point. */
  readonly crashAt?: CrashPoint | undefined;
  /** Test hook: run right before the rename, where a racer acts. */
  readonly beforeRename?:
    | ((input: { readonly abs: string; readonly rel: string }) => Promise<void> | void)
    | undefined;
  /** false turns the rooted helper off; "required" refuses to open where it cannot run. */
  readonly rooted?: boolean | "required" | undefined;
  /** Settled operations kept for replay; older ones are forgotten. Default 500. */
  readonly maxSettledOps?: number | undefined;
}

/** What a recover() call settled. "pending" means the write may still be retried. */
export interface RecoveryEntry {
  readonly operationId: string;
  /**
   * The recorded outcome, or "pending" when the journal still shows the write
   * was not applied. A pending operation can be sent again with the same id.
   */
  readonly status: MutationResult["status"] | "pending";
}

/** What the helper decided about a commit; "unknown" means it refused. */
type Commit =
  | { readonly status: "applied" }
  | { readonly status: "conflict"; readonly currentVersion: string }
  | { readonly status: "unknown" };

/**
 * Versioned file access on one root: compare-and-replace, a journal, an audit
 * trail, and a change log. See docs/workspace.md for the contract.
 *
 * @remarks
 * A write is detected, not prevented: two clients that both saw the same
 * version normally get one `applied` and one `conflict`, but a writer that
 * replaces the file between the helper's hash and its rename can still lose an
 * update. The workspace never rounds `unknown` down to `applied` or
 * `conflict`; a caller must decide what to do with it.
 *
 * All file access goes through the configured `ExecutionEnv`, and every
 * refusal is audited in the journal. `Denied` is an expected answer; a
 * `FileFailure` is an environment failure and is not audited.
 */
export class Workspace {
  readonly #env: ExecutionEnv;
  readonly #root: string;
  readonly #context: Context;
  readonly #journalPath: string;
  readonly #crashAt: CrashPoint | undefined;
  readonly #beforeRename: WorkspaceOptions["beforeRename"];
  readonly #rootedAllowed: boolean;
  readonly #rootedRequired: boolean;
  readonly #maxSettledOps: number;
  readonly #listeners = new Set<(event: FileEvent) => void>();
  readonly #known = new Map<string, Version>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #canonicalRoot = "";
  #identityPath = "";
  #identity = "";
  #journal: JournalState = emptyJournal();
  #saveChain: Promise<void> = Promise.resolve();
  #watcher: FileWatcher | undefined;
  #rooted: Rooted | undefined;
  #claimKey = "";

  private constructor(options: WorkspaceOptions) {
    this.#env = options.env;
    this.#root = options.root;
    this.#context = options.context;
    this.#journalPath = options.journalPath;
    this.#crashAt = options.crashAt;
    this.#beforeRename = options.beforeRename;
    this.#rootedAllowed = options.rooted !== false;
    this.#rootedRequired = options.rooted === "required";
    this.#maxSettledOps = Math.max(1, options.maxSettledOps ?? DEFAULT_MAX_SETTLED_OPS);
  }

  /**
   * Pin the root, load the journal, and decide whether the helper can hold it.
   *
   * @param options - The environment, root, journal path, and the test hooks.
   * @returns An open workspace, with its identity established.
   * @throws {Denied} When the root's marker names another workspace, or the root
   * was replaced since the journal was written.
   * @throws {Unavailable} When `rooted: "required"` is set and the helper
   * cannot run on this host, or when this process already has the same journal
   * path open. `close` releases the journal claim; a process that exits
   * releases it with everything else it held.
   * @throws {FileError} When the root itself cannot be canonicalized, which is
   * how a missing or unreadable root is refused.
   * @throws {Error} When the journal file is readable but its content is not a
   * valid journal: a corrupt journal is a refusal, not a fresh workspace. A read
   * that fails is treated as an absent journal.
   *
   * @remarks
   * Opening is the only time the root is canonicalized. A root that is a
   * symbolic link stays pinned to what it resolved to here; replacing the link
   * later does not move the workspace.
   */
  static async open(options: WorkspaceOptions): Promise<Workspace> {
    const workspace = new Workspace(options);
    await workspace.#claimJournal();
    try {
      await workspace.#initialize();
      return workspace;
    } catch (error) {
      workspace.#releaseJournal();
      throw error;
    }
  }

  /**
   * Pin the root and read the persisted state before any operation relies on it.
   *
   * @remarks
   * The root is canonicalized first, so an unusable root is refused before the
   * journal is touched. An absent journal is a new workspace; a readable journal
   * whose content is corrupt throws. A journal read that fails is treated as an
   * absent journal. Events already in the journal seed the known-version map, so
   * a watcher does not re-emit a change the workspace itself made before the restart.
   */
  async #initialize(): Promise<void> {
    this.#canonicalRoot = getOrThrow(await this.#env.canonicalPath(this.#root, this.#context));
    const read = await this.#env.readTextFile(this.#journalPath, this.#context);
    // An absent journal is a new workspace; a corrupt one must throw, not read as empty.
    this.#journal = read.ok ? parseJournal(JSON.parse(read.value)) : emptyJournal();
    this.#trimOps();
    for (const event of this.#journal.events) {
      if (event.kind === "changed" || event.kind === "created")
        this.#known.set(event.path, event.version);
    }
    this.#identityPath = this.#canonicalRoot + "/.hns/root.json";
    this.#identity = await this.#establishIdentity();
    await this.#removeOrphanTemps();
    this.#rooted = this.#rootedAllowed
      ? await Rooted.probe({
          env: this.#env,
          root: this.#canonicalRoot,
          id: this.#identity,
          context: this.#context,
        })
      : undefined;
    if (this.#rooted === undefined && this.#rootedRequired) {
      throw new Unavailable("the rooted helper is required but cannot run on this host");
    }
  }

  /**
   * Take this process's claim on the journal path, or refuse to open.
   *
   * @throws {Unavailable} When this process already holds the same absolute
   * journal path.
   * @throws {FileError} When the path cannot be made absolute.
   */
  async #claimJournal(): Promise<void> {
    const key = getOrThrow(await this.#env.absolutePath(this.#journalPath, this.#context));
    if (JOURNAL_CLAIMS.has(key)) {
      throw new Unavailable("the journal is already open in this process");
    }
    JOURNAL_CLAIMS.add(key);
    this.#claimKey = key;
  }

  /** Give the claim back; both a failed open and close do this. */
  #releaseJournal(): void {
    if (this.#claimKey === "") return;
    JOURNAL_CLAIMS.delete(this.#claimKey);
    this.#claimKey = "";
  }

  /**
   * "dirfd" when opens and renames are anchored to a directory fd, "checks" on
   * the fallback.
   *
   * @remarks
   * "checks" still compares versions and re-canonicalizes before the rename, but
   * a swapped parent can redirect it. The getter exposes which path is in use, so
   * a caller that requires containment can refuse to continue.
   */
  get mode(): "dirfd" | "checks" {
    return this.#rooted === undefined ? "checks" : "dirfd";
  }

  /**
   * Refused operations, for the audit trail, oldest first.
   *
   * @remarks
   * The array and its entries are copies, so a caller that changes what it got
   * cannot change the journal or the next read.
   */
  get auditLog(): readonly AuditEntry[] {
    return this.#journal.audit.map((entry) => ({ ...entry }));
  }

  /**
   * Bind the workspace to this directory. The id lives in the journal (outside
   * the root); the marker inside the root is a copy. A missing or different
   * marker means the root was replaced, and we fail closed.
   *
   * @returns The id the journal and every helper call carry.
   * @throws {Denied} When the journal has an id and the root's marker does not
   * name it. A fresh workspace (no journal id) adopts the marker's id when the
   * root already has one, so losing the journal does not give the same root a
   * second identity; otherwise it mints one and writes the marker.
   */
  async #establishIdentity(): Promise<string> {
    const marker = await this.#env.readTextFile(this.#identityPath, this.#context);
    const markerId = marker.ok ? parseMarker(marker.value) : undefined;

    if (this.#journal.id === undefined) {
      const id = markerId ?? randomUUID();
      this.#journal.id = id;
      await this.#save();
      if (markerId === undefined) {
        const markerBody = JSON.stringify({ id, createdAt: new Date().toISOString() });
        this.#require(
          await this.#env.writeFile(this.#identityPath, markerBody, this.#context),
          "write root marker",
        );
        this.#require(
          await this.#env.flushFile(this.#identityPath, this.#context),
          "flush root marker",
        );
      }
      return id;
    }

    if (markerId !== this.#journal.id) throw new Denied("root replaced");
    return this.#journal.id;
  }

  /**
   * Re-read the marker inside the root before an operation relies on it.
   *
   * @throws {Denied} When the marker is missing, unreadable, or names another
   * workspace. A check that cannot run is a denial.
   */
  async #verifyIdentity(): Promise<void> {
    const read = await this.#env.readTextFile(this.#identityPath, this.#context);
    if (!read.ok || parseMarker(read.value) !== this.#identity) throw new Denied("root replaced");
  }

  /**
   * Serialize saves and replace the journal atomically, so a crash cannot leave
   * partial JSON.
   *
   * @returns A promise for this save, which rejects if the write failed.
   *
   * @remarks
   * Saves run one after another: a later save sees the state left by the
   * previous one. A failed save rejects its own promise but does not poison the
   * chain, so a transient failure does not wedge the journal.
   */
  #save(): Promise<void> {
    const next = this.#saveChain.then(() => this.#writeJournal());
    this.#saveChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Write the whole journal to a temp file, flush it, and rename it into place.
   *
   * @throws {FileFailure} When any of the three steps fails; the old journal is
   * still the last complete one.
   *
   * @remarks
   * The temp name carries a UUID, because a fixed one lets two writers overwrite
   * the body each is about to rename into place.
   */
  async #writeJournal(): Promise<void> {
    const temp = this.#journalPath + ".tmp-" + randomUUID();
    const body = JSON.stringify(this.#journal);
    this.#require(await this.#env.writeFile(temp, body, this.#context), "write journal");
    this.#require(await this.#env.flushFile(temp, this.#context), "flush journal");
    this.#require(
      await this.#env.renameFile(temp, this.#journalPath, this.#context),
      "rename journal",
    );
  }

  /**
   * Refuse to continue when the environment could not persist something.
   *
   * @param result - The environment result to check.
   * @param what - The step to name in the failure message.
   * @throws {FileFailure} Carrying the environment's code and the step name.
   */
  #require(result: Result<void, FileError>, what: string): void {
    if (!result.ok) throw new FileFailure(result.error.code, what + ": " + result.error.message);
  }

  /** Test hook: stop here when `crashAt` names this step. */
  #crash(step: CrashPoint): void {
    if (this.#crashAt === step) throw new Crash(step);
  }

  /**
   * Stamp an event with the next sequence number, persist it, then notify.
   *
   * @param draft - The event without `seq` or `at`; the journal assigns both.
   * @returns The stored event, with its stamp.
   *
   * @remarks
   * The journal is saved before listeners run, so a listener that reconnects
   * later replays the same event. The event and audit logs are capped at 500
   * entries each; the oldest go first. A listener that throws is ignored: the
   * stream is best effort and must not break the writer.
   */
  async #emit(draft: FileEventDraft): Promise<FileEvent> {
    const seq = String(++this.#journal.seq);
    const stamp = { seq, at: new Date().toISOString() };
    const event: FileEvent =
      draft.kind === "overflow"
        ? { ...stamp, kind: "overflow" }
        : draft.kind === "deleted"
          ? { ...stamp, kind: "deleted", path: draft.path }
          : { ...stamp, kind: draft.kind, path: draft.path, version: draft.version };
    this.#journal.events.push(event);
    if (this.#journal.events.length > 500)
      this.#journal.events.splice(0, this.#journal.events.length - 500);
    this.#trimOps();
    await this.#save();
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A listener must not break the writer; the stream is best effort by design.
      }
    }
    return event;
  }

  /**
   * Append one refusal to the journal's audit log and save it.
   *
   * @param entry - Who was refused, for what path, and why. The path is kept as
   * the attempt named it, because a denial may be the reason it cannot be
   * resolved.
   * @returns The stored entry, with its timestamp.
   */
  async #audit(entry: {
    readonly operationId: string | null;
    readonly path: string | null;
    readonly reason: string;
    readonly denied: true;
  }): Promise<AuditEntry> {
    const record: AuditEntry = { at: new Date().toISOString(), ...entry };
    this.#journal.audit.push(record);
    if (this.#journal.audit.length > 500)
      this.#journal.audit.splice(0, this.#journal.audit.length - 500);
    await this.#save();
    return record;
  }

  /**
   * Turn a caller-supplied path into names relative to the root, or refuse it.
   *
   * @param relativePath - The path as the caller wrote it; both separators are
   * accepted.
   * @returns The normalized path, without empty or "." segments.
   * @throws {Denied} For an empty path, a NUL, a POSIX-absolute path, a Windows
   * drive letter, or any ".." segment.
   *
   * @remarks
   * This is syntactic only: ".." is refused rather than resolved, so the result
   * cannot climb out. Whether the path really stays below the root is decided
   * later by canonicalizing it.
   */
  #normalize(relativePath: string): string {
    if (!relativePath || relativePath.includes("\0")) throw new Denied("invalid path");
    if (relativePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(relativePath))
      throw new Denied("absolute path");
    const parts = relativePath.split(/[\\/]+/);
    if (parts.includes("..")) throw new Denied("parent segment");
    return parts.filter((part) => part && part !== ".").join("/");
  }

  /** Join path parts through the environment, so a non-POSIX host still gets its separator. */
  async #joinPath(parts: readonly string[]): Promise<string> {
    return getOrThrow(await this.#env.joinPath([...parts], this.#context));
  }

  /**
   * Canonicalize a path that may not exist yet, so a new file still resolves.
   *
   * @param abs - An absolute path.
   * @returns The canonical result: the deepest existing ancestor canonicalized,
   * then the remaining names appended.
   * @throws {Denied} When the walk reaches "/" without finding an existing
   * ancestor, so an unresolved path is refused rather than guessed.
   *
   * @remarks
   * A path that does exist is canonicalized directly. For a new file the
   * parent is what must be real; canonicalizing it first means a symbolic link
   * in the parent chain is followed now, not by the later open.
   */
  async #canonicalForWrite(abs: string): Promise<string> {
    try {
      return getOrThrow(await this.#env.canonicalPath(abs, this.#context));
    } catch (error) {
      if (!(error instanceof FileError) || error.code !== "not_found") throw error;
      const parent = await this.#joinPath([abs, ".."]);
      if (parent === abs) throw new Denied("cannot resolve");
      const name = abs.slice(parent.length + (parent.endsWith("/") ? 0 : 1));
      return this.#joinPath([await this.#canonicalForWrite(parent), name]);
    }
  }

  /**
   * Resolve a caller path to a canonical absolute path below the pinned root.
   *
   * @param relativePath - The path as the caller wrote it.
   * @returns The normalized relative path and its canonical absolute form.
   * @throws {Denied} When the root is gone, the identity check fails, the path
   * is not normalizable, or the canonical result is not the root or below it.
   *
   * @remarks
   * The root is checked first: a workspace whose root was deleted refuses the
   * operation instead of recreating the directory. The identity check is
   * repeated on every resolution because a root can be swapped while the
   * process lives; resolution and use are as close together as the environment
   * allows, which is what `mode: "dirfd"` improves.
   */
  async #resolve(relativePath: string): Promise<{ readonly rel: string; readonly abs: string }> {
    if (!getOrThrow(await this.#env.exists(this.#canonicalRoot, this.#context))) {
      throw new Denied("root missing");
    }
    await this.#verifyIdentity();
    const rel = this.#normalize(relativePath);
    const abs = await this.#canonicalForWrite(this.#joinRoot(rel));
    if (abs !== this.#canonicalRoot && !abs.startsWith(this.#canonicalRoot + "/"))
      throw new Denied("escapes root");
    return { rel, abs };
  }

  /** The absolute path for a normalized relative path; "" is the root itself. */
  #joinRoot(rel: string): string {
    return this.#canonicalRoot + (rel ? "/" + rel : "");
  }

  /**
   * The path below the root, as names; it is canonical, so each one is a name.
   *
   * @throws {Denied} When `abs` is outside the root.
   */
  #partsOf(abs: string): readonly string[] {
    if (abs === this.#canonicalRoot) return [];
    if (!abs.startsWith(this.#canonicalRoot + "/")) throw new Denied("escapes root");
    return abs.slice(this.#canonicalRoot.length + 1).split("/");
  }

  /**
   * Translate a helper failure into the error the workspace reports.
   *
   * @returns `Denied` for a replaced or missing root, otherwise a
   * `FileFailure`: with the mapped helper code, or with code `unknown` when the
   * reply was not a failure at all (the caller asked with the wrong op).
   */
  #helperFailure(outcome: HelperOutcome): Error {
    if (outcome.kind !== "failed") return new FileFailure("unknown", "unexpected helper reply");
    if (outcome.code === "root_replaced") return new Denied("root replaced");
    if (outcome.code === "root_missing") return new Denied("root missing");
    return new FileFailure(HELPER_CODES.get(outcome.code) ?? "unknown", outcome.message);
  }

  /**
   * Read through an opened handle, refusing a final symbolic link.
   *
   * @param abs - A canonical absolute path below the root.
   * @returns The file's bytes.
   * @throws {Denied} When the helper refuses the root.
   * @throws {FileFailure} When the file is missing, unreadable, or not a file.
   *
   * @remarks
   * With the helper, the read happens through its dirfd (`O_NOFOLLOW` on the
   * final component). Without it, the environment opens with `noFollow` and the
   * bytes are read in 1 MiB chunks. File errors are translated so callers see
   * one vocabulary.
   */
  async #readBytes(abs: string): Promise<Uint8Array> {
    try {
      if (this.#rooted !== undefined) {
        const outcome = await this.#rooted.read(this.#partsOf(abs));
        if (outcome.kind === "content") return outcome.bytes;
        throw this.#helperFailure(outcome);
      }
      const opened = await this.#env.openBinaryReader(abs, { noFollow: true }, this.#context);
      if (!opened.ok) throw opened.error;
      const reader = opened.value;
      try {
        const info = getOrThrow(await reader.info(this.#context));
        const chunks: Uint8Array[] = [];
        let offset = 0;
        while (offset < info.size) {
          const part = getOrThrow(
            await reader.read(offset, Math.min(1 << 20, info.size - offset), this.#context),
          );
          if (part.length === 0) break;
          chunks.push(part);
          offset += part.length;
        }
        return Buffer.concat(chunks);
      } finally {
        await reader.close(this.#context);
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw asFileFailure(error);
    }
  }

  /**
   * The version of a file on disk, or "absent" when it does not exist.
   *
   * @param abs - A canonical absolute path below the root.
   * @returns The version of the bytes, or "absent" for a free name.
   * @throws {Denied} When the helper refuses the root.
   * @throws {FileFailure} For any other read failure; a permission error must
   * not be mistaken for an absent file.
   */
  async #versionOfFile(abs: string): Promise<AbsentVersion> {
    if (this.#rooted !== undefined) {
      const outcome = await this.#rooted.hash(this.#partsOf(abs));
      if (outcome.kind === "version") return outcome.version;
      if (outcome.kind === "failed" && outcome.code === "not_found") return "absent";
      throw this.#helperFailure(outcome);
    }
    try {
      return sha(await this.#readBytes(abs));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const failure = asFileFailure(error);
      if (failure instanceof FileFailure && failure.code === "not_found") return "absent";
      throw failure;
    }
  }

  /**
   * Read one file, with its version.
   *
   * @param relativePath - The path relative to the root, as a caller would
   * write it.
   * @returns The decoded content and the version of the bytes that were read.
   * @throws {Denied} When the path cannot be resolved below the root, or the
   * root is gone or replaced. The refusal is audited.
   * @throws {FileFailure} When the file cannot be read.
   *
   * @remarks
   * One resolution and one open: the version is computed from the bytes that
   * were read, so it always names the content the caller received. The content
   * is decoded as UTF-8, so this method is for text; bytes that are not valid
   * UTF-8 do not round-trip.
   */
  async read(relativePath: string): Promise<FileRead> {
    try {
      const { rel, abs } = await this.#resolve(relativePath);
      const bytes = await this.#readBytes(abs);
      return { path: rel, content: dec.decode(bytes), version: sha(bytes) };
    } catch (error) {
      if (error instanceof Denied) {
        await this.#audit({
          operationId: null,
          path: relativePath,
          reason: error.message,
          denied: true,
        });
      }
      if (!(error instanceof Error)) throw error;
      throw asFileFailure(error);
    }
  }

  /**
   * Whether a path, resolved the way a write resolves it, is the root or below it.
   *
   * @param path - The path to test; it may name a file that does not exist yet.
   * @returns true for the root itself or a path below it, false when it escapes
   * the root or cannot be normalized.
   * @throws {Error} When canonicalization fails for a reason other than a
   * refusal (a `Denied` is answered as false).
   *
   * @remarks
   * The resolution is the same one a write uses, including the "deepest
   * existing ancestor" rule for new files, so a cwd check here answers the
   * question a write would ask. It reads the filesystem now and does not pin
   * the root's identity; it is a boundary check, not a race-free guarantee.
   */
  async contains(path: string): Promise<boolean> {
    try {
      const abs = await this.#canonicalForWrite(path);
      return abs === this.#canonicalRoot || abs.startsWith(this.#canonicalRoot + "/");
    } catch (error) {
      if (error instanceof Denied) return false;
      throw error;
    }
  }

  /**
   * Compare an unsettled intent with what is on disk now, and settle it if the
   * answer is decidable.
   *
   * @param opId - The journal key of the intent.
   * @returns The recorded outcome, or undefined when the write was not applied
   * and can be retried under the same id.
   * @throws {Denied} When the id is not in the journal.
   *
   * @remarks
   * Content equal to the intent's hash means the write landed; content equal to
   * `expectedVersion` means it did not. Anything else -- the file changed in a
   * way the intent does not explain, or disappeared -- is recorded as
   * `unknown`, because neither `applied` nor `conflict` would be true.
   */
  async #reconcile(opId: string): Promise<MutationResult | undefined> {
    const rec = this.#journal.ops[opId];
    if (rec === undefined) throw new Denied("unknown operation");
    const current = await this.#versionOfFile(rec.abs);
    if (current === rec.contentHash) {
      return this.#record(opId, { status: "applied", operationId: opId, version: rec.contentHash });
    }
    if (current === rec.expectedVersion) return undefined;
    return this.#record(opId, { status: "unknown", operationId: opId, reason: "io" });
  }

  /**
   * Store an outcome on its intent and save the journal.
   *
   * @param opId - The journal key of the intent.
   * @param outcome - The result the caller will receive.
   * @returns The same outcome, once it is persisted.
   * @throws {Denied} When the id is not in the journal.
   */
  async #record(opId: string, outcome: MutationResult): Promise<MutationResult> {
    const rec = this.#journal.ops[opId];
    if (rec === undefined) throw new Denied("unknown operation");
    rec.outcome = outcome;
    this.#trimOps();
    await this.#save();
    return outcome;
  }

  /**
   * Keep the journal bounded: forget the oldest settled operations. A pending
   * one is never dropped, because recovery still needs it.
   *
   * @remarks
   * Forgetting a settled operation means a replay of that id is treated as a
   * new write; the caller-visible window is `maxSettledOps`.
   */
  #trimOps(): void {
    const settled = Object.keys(this.#journal.ops).filter(
      (opId) => this.#journal.ops[opId]?.outcome !== undefined,
    );
    const excess = settled.length - this.#maxSettledOps;
    for (const opId of settled.slice(0, Math.max(0, excess))) delete this.#journal.ops[opId];
  }

  /**
   * Replace one file if it is still at expectedVersion.
   *
   * @param input - The path, content, expected version, and attempt id.
   * @returns `applied` with the new version, `conflict` with what is there now,
   * or `unknown` when the outcome cannot be decided.
   * @throws {Denied} For an invalid `operationId`, a path the workspace refuses,
   * a write below `.git`, a replaced root, or an id reused with different
   * content or another expected version. The refusal is audited.
   * @throws {FileFailure} When the environment fails to write, flush, or rename.
   *
   * @remarks
   * A replay with the same id and the same content and expected version returns
   * the recorded outcome; it never applies twice. `unknown` is never collapsed
   * into `applied` or `conflict`: the write may or may not have happened, and
   * only the caller can decide whether to retry. On `applied` the journal first
   * records the outcome, then emits `created` or `changed`.
   */
  async write(input: FileWrite): Promise<MutationResult> {
    let opId: OperationId;
    try {
      opId = operationId(input.operationId);
    } catch {
      // The id cannot be a journal key, but the refusal is still an audit event.
      const denied = new Denied("invalid operationId");
      await this.#audit({
        operationId: null,
        path: input.path,
        reason: denied.message,
        denied: true,
      });
      throw denied;
    }
    try {
      return await this.#write({ ...input, operationId: opId });
    } catch (error) {
      if (error instanceof Denied) {
        await this.#audit({
          operationId: opId,
          path: input.path,
          reason: error.message,
          denied: true,
        });
      }
      if (!(error instanceof Error)) throw error;
      throw asFileFailure(error);
    }
  }

  /**
   * One attempt, in the order a crash can be recovered from.
   *
   * @remarks
   * Resolve, then record the intent, then write and flush a temp, then commit:
   * through the helper (re-hash and rename from one pinned parent) when it is
   * available, or with the checks path otherwise (re-hash, re-canonicalize the
   * parent, verify identity, rename). A conflict or an undecidable commit
   * removes the temp and records the answer. After a successful rename the path
   * is canonicalized once more, and an escape is audited and recorded as
   * `unknown` rather than treated as applied.
   */
  async #write(input: FileWrite): Promise<MutationResult> {
    const { rel, abs } = await this.#resolve(input.path);
    if (rel === ".git" || rel.startsWith(".git/")) throw new Denied("git is read-only");
    const bytes = input.content instanceof Uint8Array ? input.content : enc.encode(input.content);
    const contentHash = sha(bytes);
    const { operationId, expectedVersion } = input;

    let rec = this.#journal.ops[operationId];
    if (rec !== undefined) {
      // An operationId names one attempt: reusing it for another write is a bug, not a replay.
      if (rec.contentHash !== contentHash || rec.expectedVersion !== expectedVersion) {
        throw new Denied("operationId reused with different content");
      }
      if (rec.outcome !== undefined) return rec.outcome;
      const settled = await this.#reconcile(operationId);
      if (settled !== undefined) return settled;
      const pending = this.#journal.ops[operationId];
      if (pending === undefined) throw new Denied("unknown operation");
      rec = pending;
    }

    const current = await this.#versionOfFile(abs);
    const existed = current !== "absent";
    if (rec === undefined) {
      if (current !== expectedVersion) {
        // Record the conflict so a retry keeps the same answer instead of applying later.
        const conflict: MutationResult = {
          status: "conflict",
          operationId,
          currentVersion: current,
        };
        this.#journal.ops[operationId] = {
          abs,
          rel,
          expectedVersion,
          contentHash,
          temp: "",
          outcome: conflict,
        };
        this.#trimOps();
        await this.#save();
        return conflict;
      }
      const intent: JournalIntent = {
        abs,
        rel,
        expectedVersion,
        contentHash,
        // operationId is only a journal key. Never put it in a path; the temp name is ours.
        temp: this.#canonicalRoot + "/.hns-tmp-" + randomUUID(),
      };
      this.#journal.ops[operationId] = intent;
      await this.#save();
      this.#crash("intent");
      rec = intent;
    }

    this.#require(await this.#env.writeFile(rec.temp, bytes, this.#context), "write temp");
    this.#require(await this.#env.flushFile(rec.temp, this.#context), "flush temp");
    this.#crash("temp");

    if (this.#beforeRename !== undefined) await this.#beforeRename({ abs, rel });

    if (this.#rooted !== undefined) {
      // Compare and rename inside the helper, under one pinned parent.
      const committed = await this.#commitRooted(rec, abs, expectedVersion);
      if (committed.status === "conflict") {
        await this.#removeTemp(rec, operationId);
        return this.#record(operationId, {
          status: "conflict",
          operationId,
          currentVersion: committed.currentVersion,
        });
      }
      if (committed.status !== "applied") {
        await this.#removeTemp(rec, operationId);
        return this.#record(operationId, { status: "unknown", operationId, reason: "io" });
      }
    } else {
      const again = await this.#versionOfFile(abs);
      if (again !== expectedVersion) {
        await this.#removeTemp(rec, operationId);
        return this.#record(operationId, {
          status: "conflict",
          operationId,
          currentVersion: again,
        });
      }
      const parent = abs.slice(0, abs.lastIndexOf("/"));
      const parentNow = await this.#canonicalForWrite(parent);
      if (parentNow !== parent) {
        await this.#removeTemp(rec, operationId);
        return this.#record(operationId, { status: "unknown", operationId, reason: "io" });
      }
      try {
        await this.#verifyIdentity();
      } catch (error) {
        if (!(error instanceof Denied)) throw error;
        await this.#removeTemp(rec, operationId);
        return this.#record(operationId, { status: "unknown", operationId, reason: "io" });
      }
      this.#require(await this.#env.renameFile(rec.temp, abs, this.#context), "rename");
    }

    // A parent swapped for a link can leave our target resolving outside.
    try {
      const after = await this.#canonicalForWrite(abs);
      if (after !== abs && !after.startsWith(this.#canonicalRoot + "/")) {
        await this.#audit({ operationId, path: rel, reason: "escaped after rename", denied: true });
        return this.#record(operationId, { status: "unknown", operationId, reason: "io" });
      }
    } catch {
      // Best effort: the rename has already happened, so a failed check only loses the audit line.
    }
    this.#crash("rename");

    const outcome = await this.#record(operationId, {
      status: "applied",
      operationId,
      version: contentHash,
    });
    this.#known.set(rel, contentHash);
    await this.#emit({ kind: existed ? "changed" : "created", path: rel, version: contentHash });
    return outcome;
  }

  /**
   * Remove the temp file after a commit that did not apply.
   *
   * @param rec - The intent whose temp is no longer needed.
   * @param operationId - The attempt, for the audit entry when the removal fails.
   *
   * @remarks
   * A removal that fails is audited rather than dropped: the orphan stays beside
   * the root under a name the watcher ignores, so the audit trail is the only
   * place it would surface. The write's own outcome is still recorded.
   */
  async #removeTemp(rec: JournalIntent, operationId: string): Promise<void> {
    const removed = await this.#env.remove(rec.temp, { force: true }, this.#context);
    if (removed.ok) return;
    await this.#audit({
      operationId,
      path: rec.rel,
      reason: "cannot remove temp: " + removed.error.message,
      denied: true,
    });
  }

  /**
   * Remove temp files a previous write left in the root, except the ones a
   * pending intent still owns.
   *
   * @remarks
   * A crash after the intent was saved leaves its temp behind; recovery reads
   * that intent, so its temp must stay. Every other `.hns-tmp-*` file directly
   * in the root is orphaned. A listing that fails is not a reason to refuse the
   * open; a removal that fails is audited and not retried here. A second journal
   * over the same root is not supported, so only this journal's intents are
   * spared.
   */
  async #removeOrphanTemps(): Promise<void> {
    const listed = await this.#env.listDir(this.#canonicalRoot, this.#context);
    if (!listed.ok) return;
    const pending = new Set<string>();
    for (const rec of Object.values(this.#journal.ops)) {
      if (rec.outcome === undefined && rec.temp !== "") pending.add(rec.temp);
    }
    for (const entry of listed.value) {
      if (entry.kind !== "file" || !entry.name.startsWith(".hns-tmp-")) continue;
      const abs = this.#joinRoot(entry.name);
      if (pending.has(abs)) continue;
      const removed = await this.#env.remove(abs, { force: true }, this.#context);
      if (removed.ok) continue;
      await this.#audit({
        operationId: null,
        path: entry.name,
        reason: "cannot remove orphan temp: " + removed.error.message,
        denied: true,
      });
    }
  }

  /**
   * Commit through the helper, which re-hashes and renames from one parent dirfd.
   *
   * @returns `applied`, `conflict` with the current version, or `unknown` for a
   * reply the workspace cannot act on.
   * @throws {Denied} When the helper is off or the temp name is not a single
   * component. A temp path built by the workspace always is; this refuses one
   * that was tampered with in the journal.
   * @throws {FileFailure} When the helper reports a missing parent, which the
   * path-based call would also report as a failed rename.
   */
  async #commitRooted(
    rec: JournalIntent,
    abs: string,
    expectedVersion: AbsentVersion,
  ): Promise<Commit> {
    if (this.#rooted === undefined) throw new Denied("rooted helper is off");
    const temp = rec.temp.slice(this.#canonicalRoot.length + 1);
    if (temp.includes("/")) throw new Denied("bad temp name");
    const outcome = await this.#rooted.commit(this.#partsOf(abs), temp, expectedVersion);
    if (outcome.kind === "applied") return { status: "applied" };
    if (outcome.kind === "conflict")
      return { status: "conflict", currentVersion: outcome.currentVersion };
    // A missing parent is a failed rename, as the path-based call would report.
    if (outcome.kind === "failed" && outcome.code === "not_found")
      throw this.#helperFailure(outcome);
    return { status: "unknown" };
  }

  /**
   * Settle every intent left without an outcome; call on startup.
   *
   * @returns One entry per unsettled intent, in journal order. A status of
   * "pending" means the write was not applied and may still be retried with the
   * same id; the others are the recorded outcomes.
   *
   * @remarks
   * Recovery reconciles against the disk, it does not redo the write. Calling it
   * twice is harmless: an intent that gained an outcome is skipped.
   */
  async recover(): Promise<RecoveryEntry[]> {
    const settled: RecoveryEntry[] = [];
    for (const opId of Object.keys(this.#journal.ops)) {
      const rec = this.#journal.ops[opId];
      if (rec === undefined || rec.outcome !== undefined) continue;
      const outcome = await this.#reconcile(opId);
      settled.push({
        operationId: opId,
        status: outcome === undefined ? "pending" : outcome.status,
      });
    }
    return settled;
  }

  /**
   * Watch the root through ExecutionEnv; reports changed / created / deleted /
   * overflow.
   *
   * @returns The underlying watcher, for stopping it early; `close` stops it too.
   * @throws {FileError} When the environment cannot watch. The workspace does not
   * install a fallback, because a watcher that silently misses changes would
   * break the event contract.
   *
   * @remarks
   * Changes are debounced per path for 100 ms, then re-hashed: the event carries
   * what the disk says, not what the watcher guessed. A change to the workspace's
   * own temp files or `.hns/` is ignored, and so is a path outside the root.
   */
  async startWatching(): Promise<FileWatcher> {
    const result = await this.#env.watch(
      [{ path: this.#canonicalRoot, recursive: true }],
      (change) => {
        void this.#onChange(change).catch(() => this.#watchFailed());
      },
      this.#context,
    );
    if (!result.ok) throw result.error;
    this.#watcher = result.value;
    return result.value;
  }

  /**
   * Turn one watcher callback into per-path debounced settlements.
   *
   * @remarks
   * An overflow or a failed watch means coverage is uncertain, so the whole
   * stream is told to re-read. For a normal change, the last event for a path
   * within 100 ms wins; the timer then hashes the path once instead of acting on
   * every intermediate write. The workspace's own temp files and `.hns/` are
   * skipped because their lifecycle is internal.
   */
  async #onChange(change: FileChange): Promise<void> {
    if (change.kind === "overflow" || change.kind === "failed") {
      await this.#emit({ kind: "overflow" });
      return;
    }
    for (const abs of change.paths) {
      if (abs.includes("/.hns-tmp-") || abs.includes("/.hns/")) continue;
      const rel = abs.startsWith(this.#canonicalRoot + "/")
        ? abs.slice(this.#canonicalRoot.length + 1)
        : undefined;
      if (rel === undefined) continue;
      const prior = this.#timers.get(rel);
      if (prior !== undefined) clearTimeout(prior);
      this.#timers.set(
        rel,
        setTimeout(() => {
          this.#timers.delete(rel);
          void this.#settlePath(rel).catch(() => this.#watchFailed());
        }, 100),
      );
    }
  }

  /**
   * A watcher callback has no caller: keep the process alive and resync with an
   * overflow.
   *
   * @remarks
   * The event is the only channel left; swallowing a failure here would leave
   * watchers believing they are in sync.
   */
  #watchFailed(): void {
    void this.#emit({ kind: "overflow" }).catch(() => undefined);
  }

  /**
   * Re-hash one changed path and emit what actually happened.
   *
   * @param rel - The normalized path below the root.
   *
   * @remarks
   * A directory that replaces a file reads as a deletion, and an unreadable path
   * falls back to `overflow` because the version cannot be trusted. An unchanged
   * version emits nothing, which is how the workspace's own write and the
   * watcher's echo do not become two events.
   */
  async #settlePath(rel: string): Promise<void> {
    let version: AbsentVersion;
    try {
      version = await this.#versionOfFile(this.#joinRoot(rel));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const failure = asFileFailure(error);
      // Directories are not files; a directory that replaces a file reads as a deletion.
      if (
        failure instanceof FileFailure &&
        (failure.code === "is_directory" || failure.code === "invalid")
      ) {
        if (this.#known.delete(rel)) await this.#emit({ kind: "deleted", path: rel });
        return;
      }
      await this.#emit({ kind: "overflow" });
      return;
    }
    if (version === "absent") {
      if (this.#known.delete(rel)) await this.#emit({ kind: "deleted", path: rel });
      return;
    }
    if (this.#known.get(rel) === version) return;
    const created = !this.#known.has(rel);
    this.#known.set(rel, version);
    await this.#emit({ kind: created ? "created" : "changed", path: rel, version });
  }

  /**
   * Test hook: treat coverage as uncertain, as a reconnect would.
   *
   * @returns The stored overflow event.
   */
  async overflow(): Promise<FileEvent> {
    return this.#emit({ kind: "overflow" });
  }

  /**
   * Replay from the cursor (exclusive), then stream.
   *
   * @param cursor - The last sequence number the caller saw, as a decimal
   * string; "0" starts from the beginning. Anything that is not a number is
   * treated as 0.
   * @returns An async generator of events whose `seq` is greater than the
   * cursor, in order, continuing with live events.
   *
   * @remarks
   * The listener is registered before the replay, so an event emitted between
   * the two is not lost; duplicates are filtered by the sequence number. The
   * journal keeps only the most recent 500 events, so an older cursor replays
   * what is left and should be treated as possibly incomplete. Closing the
   * generator removes the listener; a caller that stops iterating without
   * closing it leaves one registered.
   */
  async *watch(cursor = "0"): AsyncGenerator<FileEvent> {
    let last = Number(cursor) || 0;
    const queue: FileEvent[] = [];
    let wake: (() => void) | undefined;
    const listener = (event: FileEvent): void => {
      queue.push(event);
      wake?.();
      wake = undefined;
    };
    this.#listeners.add(listener);
    try {
      for (const event of this.#journal.events) {
        if (Number(event.seq) > last) {
          last = Number(event.seq);
          yield event;
        }
      }
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        for (const event of queue.splice(0)) {
          if (Number(event.seq) > last) {
            last = Number(event.seq);
            yield event;
          }
        }
      }
    } finally {
      this.#listeners.delete(listener);
    }
  }

  /**
   * Stop watching: clear the debounce timers and stop the underlying watcher.
   *
   * @remarks
   * Pending settlements are dropped rather than flushed; the journal and audit
   * log stay as they are. The journal claim is released even when stopping the
   * watcher fails, so the path can be opened again.
   */
  async close(): Promise<void> {
    try {
      for (const timer of this.#timers.values()) clearTimeout(timer);
      this.#timers.clear();
      if (this.#watcher !== undefined) await this.#watcher.stop(this.#context);
    } finally {
      this.#releaseJournal();
    }
  }
}
