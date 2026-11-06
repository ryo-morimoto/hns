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
import type { FileRead, MutationResult } from "@hns/core";
import { Crash, Denied, FileFailure } from "./errors.ts";
import type { CrashPoint } from "./errors.ts";
import { emptyJournal, parseJournal } from "./journal.ts";
import { parseMarker } from "./protocol.ts";
import type { HelperOutcome } from "./protocol.ts";
import { Rooted } from "./rooted.ts";
import type {
  AuditEntry,
  ExpectedVersion,
  FileEvent,
  FileEventDraft,
  JournalIntent,
  JournalState,
  Version,
} from "./types.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const sha = (bytes: Uint8Array): Version =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");

// The same shape as core's OPERATION_ID_PATTERN. It is duplicated because the workspace must not
// import @hns/core at runtime: a test run would depend on core's built dist (npm test before build).
const JOURNAL_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** ExecutionEnv reports file failures as FileError; the workspace speaks FileFailure. */
function asFileFailure(error: Error): Error {
  if (error instanceof FileFailure) return error;
  if (error instanceof FileError) return new FileFailure(error.code, error.message);
  return error;
}

/** Helper failure codes in pi-durable's vocabulary, so callers branch on code. */
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
  readonly path: string;
  /** UTF-8 text, or raw bytes when the caller already has them. */
  readonly content: string | Uint8Array;
  readonly expectedVersion: ExpectedVersion;
  readonly operationId: string;
}

export interface WorkspaceOptions {
  readonly env: ExecutionEnv;
  readonly root: string;
  /** Outside the root; the journal is not part of the workspace tree. */
  readonly journalPath: string;
  readonly context: Context;
  /** Test hook: stop the write at a crash point. */
  readonly crashAt?: CrashPoint | undefined;
  /** Test hook: run right before the rename, where a racer acts. */
  readonly beforeRename?:
    | ((input: { readonly abs: string; readonly rel: string }) => Promise<void> | void)
    | undefined;
  /** false turns the rooted helper off, as an unsupported environment would. */
  readonly rooted?: boolean | undefined;
}

/** What a recover() call settled. "pending" means the write may still be retried. */
export interface RecoveryEntry {
  readonly operationId: string;
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
 */
export class Workspace {
  readonly #env: ExecutionEnv;
  readonly #root: string;
  readonly #context: Context;
  readonly #journalPath: string;
  readonly #crashAt: CrashPoint | undefined;
  readonly #beforeRename: WorkspaceOptions["beforeRename"];
  readonly #rootedAllowed: boolean;
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

  private constructor(options: WorkspaceOptions) {
    this.#env = options.env;
    this.#root = options.root;
    this.#context = options.context;
    this.#journalPath = options.journalPath;
    this.#crashAt = options.crashAt;
    this.#beforeRename = options.beforeRename;
    this.#rootedAllowed = options.rooted !== false;
  }

  /** Pin the root, load the journal, and decide whether the helper can hold it. */
  static async open(options: WorkspaceOptions): Promise<Workspace> {
    const workspace = new Workspace(options);
    await workspace.#initialize();
    return workspace;
  }

  async #initialize(): Promise<void> {
    this.#canonicalRoot = getOrThrow(await this.#env.canonicalPath(this.#root, this.#context));
    const read = await this.#env.readTextFile(this.#journalPath, this.#context);
    // An absent journal is a new workspace; a corrupt one must throw, not read as empty.
    this.#journal = read.ok ? parseJournal(JSON.parse(read.value)) : emptyJournal();
    for (const event of this.#journal.events) {
      if (event.kind === "changed" || event.kind === "created")
        this.#known.set(event.path, event.version);
    }
    this.#identityPath = this.#canonicalRoot + "/.hns/root.json";
    this.#identity = await this.#establishIdentity();
    this.#rooted = this.#rootedAllowed
      ? await Rooted.probe({
          env: this.#env,
          root: this.#canonicalRoot,
          id: this.#identity,
          context: this.#context,
        })
      : undefined;
  }

  /** "dirfd" when opens and renames are anchored to a directory fd, "checks" on the fallback. */
  get mode(): "dirfd" | "checks" {
    return this.#rooted === undefined ? "checks" : "dirfd";
  }

  /** Refused operations, for the audit trail. */
  get auditLog(): readonly AuditEntry[] {
    return this.#journal.audit;
  }

  /**
   * Bind the workspace to this directory. The id lives in the journal (outside
   * the root); the marker inside the root is a copy. A missing or different
   * marker means the root was replaced, and we fail closed.
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

  async #verifyIdentity(): Promise<void> {
    const read = await this.#env.readTextFile(this.#identityPath, this.#context);
    if (!read.ok || parseMarker(read.value) !== this.#identity) throw new Denied("root replaced");
  }

  /** Serialize saves and replace the journal atomically, so a crash cannot leave partial JSON. */
  #save(): Promise<void> {
    const next = this.#saveChain.then(() => this.#writeJournal());
    this.#saveChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #writeJournal(): Promise<void> {
    const temp = this.#journalPath + ".tmp";
    const body = JSON.stringify(this.#journal);
    this.#require(await this.#env.writeFile(temp, body, this.#context), "write journal");
    this.#require(await this.#env.flushFile(temp, this.#context), "flush journal");
    this.#require(
      await this.#env.renameFile(temp, this.#journalPath, this.#context),
      "rename journal",
    );
  }

  /** Refuse to continue when the environment could not persist something. */
  #require(result: Result<void, FileError>, what: string): void {
    if (!result.ok) throw new FileFailure(result.error.code, what + ": " + result.error.message);
  }

  #crash(step: CrashPoint): void {
    if (this.#crashAt === step) throw new Crash(step);
  }

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

  #normalize(relativePath: string): string {
    if (!relativePath || relativePath.includes("\0")) throw new Denied("invalid path");
    if (relativePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(relativePath))
      throw new Denied("absolute path");
    const parts = relativePath.split(/[\\/]+/);
    if (parts.includes("..")) throw new Denied("parent segment");
    return parts.filter((part) => part && part !== ".").join("/");
  }

  async #joinPath(parts: readonly string[]): Promise<string> {
    return getOrThrow(await this.#env.joinPath([...parts], this.#context));
  }

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

  #joinRoot(rel: string): string {
    return this.#canonicalRoot + (rel ? "/" + rel : "");
  }

  /** The path below the root, as names; it is canonical, so each one is a name. */
  #partsOf(abs: string): readonly string[] {
    if (abs === this.#canonicalRoot) return [];
    if (!abs.startsWith(this.#canonicalRoot + "/")) throw new Denied("escapes root");
    return abs.slice(this.#canonicalRoot.length + 1).split("/");
  }

  #helperFailure(outcome: HelperOutcome): Error {
    if (outcome.kind !== "failed") return new FileFailure("unknown", "unexpected helper reply");
    if (outcome.code === "root_replaced") return new Denied("root replaced");
    if (outcome.code === "root_missing") return new Denied("root missing");
    return new FileFailure(HELPER_CODES.get(outcome.code) ?? "unknown", outcome.message);
  }

  /** Read through an opened handle, refusing a final symbolic link. */
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

  async #versionOfFile(abs: string): Promise<ExpectedVersion> {
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

  /** Read one file, with its version. */
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

  async #record(opId: string, outcome: MutationResult): Promise<MutationResult> {
    const rec = this.#journal.ops[opId];
    if (rec === undefined) throw new Denied("unknown operation");
    rec.outcome = outcome;
    await this.#save();
    return outcome;
  }

  /** Replace one file if it is still at expectedVersion. */
  async write(input: FileWrite): Promise<MutationResult> {
    try {
      return await this.#write(input);
    } catch (error) {
      if (error instanceof Denied) {
        await this.#audit({
          operationId: input.operationId,
          path: input.path,
          reason: error.message,
          denied: true,
        });
      }
      if (!(error instanceof Error)) throw error;
      throw asFileFailure(error);
    }
  }

  async #write(input: FileWrite): Promise<MutationResult> {
    if (!JOURNAL_KEY_PATTERN.test(input.operationId)) throw new Denied("invalid operationId");
    const { rel, abs } = await this.#resolve(input.path);
    if (rel === ".git" || rel.startsWith(".git/")) throw new Denied("git is read-only");
    const bytes = input.content instanceof Uint8Array ? input.content : enc.encode(input.content);
    const contentHash = sha(bytes);
    const { operationId, expectedVersion } = input;

    let rec = this.#journal.ops[operationId];
    if (rec !== undefined) {
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
        await this.#save();
        return conflict;
      }
      const intent: JournalIntent = {
        abs,
        rel,
        expectedVersion,
        contentHash,
        // Never derived from the caller's id: it is only a journal key.
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
        await this.#removeTemp(rec);
        return this.#record(operationId, {
          status: "conflict",
          operationId,
          currentVersion: committed.currentVersion,
        });
      }
      if (committed.status !== "applied") {
        await this.#removeTemp(rec);
        return this.#record(operationId, { status: "unknown", operationId, reason: "io" });
      }
    } else {
      const again = await this.#versionOfFile(abs);
      if (again !== expectedVersion) {
        await this.#removeTemp(rec);
        return this.#record(operationId, {
          status: "conflict",
          operationId,
          currentVersion: again,
        });
      }
      const parent = abs.slice(0, abs.lastIndexOf("/"));
      const parentNow = await this.#canonicalForWrite(parent);
      if (parentNow !== parent) {
        await this.#removeTemp(rec);
        return this.#record(operationId, { status: "unknown", operationId, reason: "io" });
      }
      try {
        await this.#verifyIdentity();
      } catch (error) {
        if (!(error instanceof Denied)) throw error;
        await this.#removeTemp(rec);
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

  async #removeTemp(rec: JournalIntent): Promise<void> {
    await this.#env.remove(rec.temp, { force: true }, this.#context);
  }

  async #commitRooted(
    rec: JournalIntent,
    abs: string,
    expectedVersion: ExpectedVersion,
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

  /** Settle every intent left without an outcome; call on startup. */
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

  /** Watch the root through ExecutionEnv; reports changed / created / deleted / overflow. */
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

  /** A watcher callback has no caller: keep the process alive and resync with an overflow. */
  #watchFailed(): void {
    void this.#emit({ kind: "overflow" }).catch(() => undefined);
  }

  async #settlePath(rel: string): Promise<void> {
    let version: ExpectedVersion;
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

  /** Test hook: treat coverage as uncertain, as a reconnect would. */
  async overflow(): Promise<FileEvent> {
    return this.#emit({ kind: "overflow" });
  }

  /** Replay from the cursor (exclusive), then stream. */
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

  async close(): Promise<void> {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    if (this.#watcher !== undefined) await this.#watcher.stop(this.#context);
  }
}
