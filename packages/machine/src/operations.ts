import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { Dirent } from "node:fs";
import { FileFailure, FileSystemFailure, applyVersionedWrite } from "@hns/workspace";
import type { RootIdentity } from "@hns/workspace";
import { CheckpointError, checkpointRun } from "@hns/workspace/checkpoint";
import type { Checkpoint } from "@hns/workspace/checkpoint";
import { mirrorRef } from "@hns/workspace/mirror";
import { mirrorRemoteUrl, pushCheckpoint } from "@hns/workspace/mirror-push";
import { GIT_OBJECT_TYPES, type GitObject, type GitObjectType } from "@hns/workspace/objects";
import { fitsCheckpointPack, type MachineWriteRequest, type MachineWriteResult } from "@hns/core";
import { containInRoot } from "./containment.ts";
import { runExec } from "./exec.ts";
import type { MachineExec } from "./exec.ts";
import type { Limits } from "./limits.ts";
import { MachineRefusal } from "./refusal.ts";
import type {
  CheckpointRequest,
  CheckpointResult,
  ExecResult,
  HealthResult,
  ListResult,
  MachineFileKind,
  MirrorRequest,
  MirrorResult,
  Operation,
  ReadResult,
  StatResult,
} from "./wire.ts";

/**
 * One write at a time per path, so two concurrent applies cannot both pass the version check.
 *
 * @remarks
 * The compare-and-rename window is already the documented residual race (a same-name swap
 * between the hash and the rename); serializing the machine's own writes removes the common
 * case of two of our own requests interleaving, which is what makes "one applied, one conflict"
 * hold for the editor. The map holds only the paths with a write in flight.
 *
 * @internal
 */
const writeLocks = new Map<string, Promise<void>>();

/** Run one write after any write to the same root and path has settled. */
async function withWriteLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(key) ?? Promise.resolve();
  const run = previous.then(work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  writeLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (writeLocks.get(key) === tail) writeLocks.delete(key);
  }
}

/** The result of any operation, before it is serialized. */
export type OperationResult =
  | HealthResult
  | StatResult
  | ReadResult
  | ListResult
  | MachineWriteResult
  | CheckpointResult
  | MirrorResult
  | ExecResult;

/**
 * One checkpoint at a time per root and Run.
 *
 * @remarks
 * `checkpointRun` already settles a race on the ref with a compare-and-swap, but both callers
 * of a lost race still build the pack, and the Worker would see two `created: true` answers for
 * one Run. Serializing the machine's own calls makes the second one read the first one's ref and
 * answer `created: false`, so the Run's checkpoint is decided once. The key is the root and the
 * Run id: two Runs may still checkpoint the same tree at once.
 */
const checkpointLocks = new Map<string, Promise<void>>();

/** Run one checkpoint after any checkpoint of the same root and Run has settled. */
async function withCheckpointLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = checkpointLocks.get(key) ?? Promise.resolve();
  const run = previous.then(work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  checkpointLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (checkpointLocks.get(key) === tail) checkpointLocks.delete(key);
  }
}

/**
 * Run one operation against ROOT.
 *
 * @param operation - The parsed operation from the request.
 * @param root - The canonical root; every path is resolved below it.
 * @param limits - The response bound, so a large file is refused before it is read.
 * @param signal - The request's deadline. The operation settles when it fires:
 * reads are aborted, and every other step checks the signal before and after.
 * @param identity - The root's dev / ino recorded at start; a replaced root
 * fails closed. The write op checks it, the reads rely on the canonical root.
 * @returns The operation's result, ready to serialize.
 * @throws {Denied} When the path cannot stay inside ROOT.
 * @throws {MachineRefusal} `not_found` for a missing parent, `too_large` for a
 * file over the response bound, `forbidden` for a symbolic link as the final
 * component, `invalid_request` for a non-regular file, `deadline_exceeded`
 * once the deadline passes, `invalid_request` for an unusable checkpoint Run id,
 * and `internal` for a replaced ROOT or a git failure.
 * @throws {FileFailure} With pi-durable's codes for any other file failure, so
 * the caller branches on a code instead of a message.
 */
export async function runOperation(
  operation: Operation,
  root: string,
  limits: Limits,
  signal: AbortSignal,
  identity?: RootIdentity | undefined,
  exec?: MachineExec | undefined,
): Promise<OperationResult> {
  switch (operation.op) {
    case "health":
      signal.throwIfAborted();
      return { root, pid: process.pid };
    case "stat":
      return await statPath(root, operation.path, signal);
    case "read":
      return await readPath(root, operation.path, limits, signal);
    case "list":
      return await listPath(root, operation.path, signal);
    case "write":
      return await writePath(operation, root, identity, signal);
    case "checkpoint":
      return await checkpointPath(operation, root, identity, signal);
    case "mirror":
      return await mirrorPath(operation, root, identity, signal);
    case "exec":
      // An agent built without a sandbox still answers: the answer is the refusal.
      return await runExec(
        exec ?? { ready: false, reason: "the agent was started without a sandbox" },
        operation,
        { maxOutputBytes: limits.maxResponseBytes, signal, root },
      );
  }
  const unreachable: never = operation;
  return unreachable;
}

/**
 * Turn a checkpoint failure into the refusal the Worker reads.
 *
 * @param failure - The typed failure `checkpointRun` threw.
 * @returns `invalid-run-id` is a caller error; a root that is not a work tree, or a git
 * invocation that failed, is a state the machine cannot serve, answered as `internal`.
 *
 * @remarks
 * None of them moved the ref, so the Worker may retry the whole checkpoint; the message names
 * git's own reason and ROOT, never a file's content.
 */
function refusalForCheckpoint(failure: CheckpointError): MachineRefusal {
  switch (failure.code) {
    case "invalid-run-id":
      return new MachineRefusal("invalid_request", failure.message);
    case "not-a-work-tree":
    case "git-failed":
    case "missing-object":
      return new MachineRefusal("internal", failure.message);
  }
  const unreachable: never = failure.code;
  return unreachable;
}

/**
 * Checkpoint one Run's working tree and answer with its metadata.
 *
 * @param operation - The Run id and the optional commit time.
 * @param root - The canonical ROOT; the checkpoint snapshots it as a work tree.
 * @param identity - The root's dev / ino recorded at start; a replaced root fails closed.
 * @param signal - The request's deadline.
 * @returns The checkpoint's metadata only ({@link CheckpointResult}); the pack is fetched again
 * by the upload, which needs its bytes and nothing else in the answer.
 * @throws {MachineRefusal} `invalid_request` for an unusable Run id, `internal` for a replaced
 * root or a git failure, `deadline_exceeded` once the deadline passes.
 *
 * @remarks
 * The commit is made through `@hns/workspace`'s `checkpointRun`: a private index, a parent-less
 * commit, and a compare-and-swap on `refs/hns/checkpoints/<runId>`. The user's branch, HEAD,
 * and index are not touched, and the same Run asked twice answers the same commit with
 * `created: false`. The bytes go back to disk as a pack and are `objectCount` objects; the
 * answer does not carry them, so a pack may be up to the upload limit without making the JSON
 * answer large.
 *
 * A pack larger than the upload limit is not refused here: the Run's checkpoint is made and
 * valid, and the Worker decides that the mirror is `skipped` with `too_large` (D106). The
 * upload route refuses to receive such a pack, so nothing partial is ever stored.
 */
async function checkpointPath(
  operation: CheckpointRequest,
  root: string,
  identity: RootIdentity | undefined,
  signal: AbortSignal,
): Promise<CheckpointResult> {
  signal.throwIfAborted();
  let checkpoint: Checkpoint;
  try {
    checkpoint = await withCheckpointLock(root + "\0" + operation.runId, async () => {
      await assertRootIdentity(root, identity);
      return await checkpointRun({
        root,
        runId: operation.runId,
        committedAt: operation.committedAt,
      });
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error instanceof MachineRefusal) throw error;
    if (error instanceof CheckpointError) throw refusalForCheckpoint(error);
    throw error;
  }
  signal.throwIfAborted();
  return {
    runId: checkpoint.runId,
    ref: checkpoint.ref,
    commit: checkpoint.commit,
    packKey: checkpoint.packKey,
    objectCount: checkpoint.objectCount,
    packBytes: checkpoint.packBytes,
    maxBlobBytes: checkpoint.maxBlobBytes,
    created: checkpoint.created,
  };
}

/**
 * Push one Run's checkpoint commit to Artifacts.
 *
 * @param operation - The remote, the token, the ref, the Run, and the commit.
 * @param root - The canonical ROOT, which holds the repository the commit lives in.
 * @param identity - The root's dev / ino recorded at start; a replaced root fails closed.
 * @param signal - The request's deadline.
 * @returns `mirrored` with the commit only when the push landed **and** was read back at the
 * remote; `skipped` when the ref's commit cannot be packed within Artifacts' push limit; else
 * `failed` with one of the contract's failure codes.
 * @throws {MachineRefusal} `invalid_request` for a ref that is not the Run's branch,
 * `internal` for a replaced root, `deadline_exceeded` once the deadline passes.
 *
 * @remarks
 * The push is never a reason to fail the checkpoint: every expected failure is a value here, and
 * the Worker records it as the mirror's state after the checkpoint was already acknowledged
 * (0245's invariant).
 *
 * The commit is measured before anything leaves: the object closure is packed with the
 * checkpoint's own packer and compared with the contract's 64 MiB, so a run that Artifacts would
 * refuse is answered `skipped` without a push. The 32 MiB per-file limit cannot be re-measured
 * here (it needs the machine's checkpoint metadata), so the Worker decides that one before it
 * hands out a target; this check is the pack's.
 *
 * The ref must be the one `mirrorRef` derives from the Run: a Worker that sent another ref would
 * be pushing a commit under a branch the review cannot find.
 */
async function mirrorPath(
  operation: MirrorRequest,
  root: string,
  identity: RootIdentity | undefined,
  signal: AbortSignal,
): Promise<MirrorResult> {
  signal.throwIfAborted();
  if (operation.ref !== mirrorRef(operation.runId)) {
    throw new MachineRefusal("invalid_request", "the ref is not the Run's mirror branch");
  }
  if (mirrorRemoteUrl(operation.remote) === undefined) {
    // The device key's holder names the remote. Only Artifacts' https remote is a mirror: a
    // `file://`, an `ssh://`, or an `ext::` transport would make the machine read or run
    // something that is not the mirror, so it is refused before the commit is even measured
    // (and `pushCheckpoint` repeats the check for any other caller).
    return { status: "failed", failure: "unsupported", ref: operation.ref };
  }
  await assertRootIdentity(root, identity);
  const packed = await runGitPack(root, operation.commit).catch(() => undefined);
  if (packed === undefined) return { status: "failed", failure: "unknown", ref: operation.ref };
  if (!fitsCheckpointPack(packed)) return { status: "skipped", reason: "too_large" };
  const outcome = await pushCheckpoint({
    root,
    remote: operation.remote,
    token: operation.token,
    ref: operation.ref,
    runId: operation.runId,
    commit: operation.commit,
  });
  signal.throwIfAborted();
  return outcome.status === "mirrored"
    ? { status: "mirrored", ref: outcome.ref, commit: outcome.commit }
    : { status: "failed", failure: outcome.failure, ref: outcome.ref };
}

/**
 * Pack the object closure of one commit and answer the pack's size.
 *
 * @param root - The canonical ROOT.
 * @param commit - The commit to pack.
 * @returns The pack's byte length.
 * @throws {CheckpointError} when git cannot list or read the closure.
 *
 * @remarks
 * The same packer the checkpoint uses (`@hns/workspace/objects`), so a run the checkpoint could
 * send is measured the way the upload measured it. Nothing here keeps the bytes: only the size
 * decides whether Artifacts would accept the push. The closure is read with the same
 * `rev-list` / `cat-file --batch` pair the checkpoint reads it with, under the same repository
 * variables removed, so measuring never reports a different pack than the upload sent.
 */
async function runGitPack(root: string, commit: string): Promise<number> {
  const { buildPack } = await import("@hns/workspace/objects");
  const ids = (await runMirrorGit(root, ["rev-list", "--objects", "--no-object-names", commit]))
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (ids.length === 0) throw new CheckpointError("git-failed", "the commit reaches no object");
  const output = await runMirrorGit(
    root,
    ["cat-file", "--batch"],
    Buffer.from(ids.join("\n") + "\n"),
  );
  const objects = parseBatchObjects(output);
  const pack = await buildPack(objects);
  return pack.bytes.byteLength;
}

/**
 * Run git in `root` with the repository-location variables of the caller removed.
 *
 * @param root - The canonical ROOT.
 * @param args - git's arguments, after `-C root`.
 * @param input - Bytes for git's stdin, when the call reads a list.
 * @returns git's stdout.
 * @throws {CheckpointError} when git fails; the message names the subcommand and git's stderr.
 *
 * @remarks
 * The caller's `GIT_DIR` and company would make git describe a different repository, and the
 * agent may be started from a process (a commit hook) that has them set. Removing them is the
 * same rule the checkpoint's packer applies.
 */
function runMirrorGit(root: string, args: readonly string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_NAMESPACE",
      "GIT_PREFIX",
      "GIT_COMMON_DIR",
    ]) {
      delete env[name];
    }
    const child = spawn("git", ["-C", root, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", (error: Error) => {
      reject(new CheckpointError("git-failed", "git " + String(args[0]) + ": " + error.message));
    });
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(
        new CheckpointError(
          "git-failed",
          "git " +
            String(args[0]) +
            " exited " +
            String(code) +
            (detail === "" ? "" : ": " + detail),
        ),
      );
    });
    child.stdin.end(input);
  });
}

/** Whether a `cat-file` type word names one of the four git object types. */
const isGitObjectType = (value: string): value is GitObjectType => {
  for (const type of GIT_OBJECT_TYPES) {
    if (type === value) return true;
  }
  return false;
};

/** Parse `git cat-file --batch` output into objects, in input order. */
function parseBatchObjects(output: Buffer): GitObject[] {
  const objects: GitObject[] = [];
  let offset = 0;
  while (offset < output.length) {
    const newline = output.indexOf(0x0a, offset);
    if (newline === -1) throw new CheckpointError("git-failed", "truncated cat-file header");
    const header = output.subarray(offset, newline).toString("utf8");
    const [id, type, sizeText] = header.split(" ");
    if (type === "missing") {
      throw new CheckpointError("missing-object", "the repository has no object " + String(id));
    }
    if (id === undefined || type === undefined || sizeText === undefined) {
      throw new CheckpointError("git-failed", "unexpected cat-file header: " + header);
    }
    if (!/^[0-9a-f]{40}$/u.test(id) || !isGitObjectType(type)) {
      throw new CheckpointError("git-failed", "unexpected cat-file header: " + header);
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new CheckpointError("git-failed", "unexpected cat-file size: " + sizeText);
    }
    const start = newline + 1;
    const end = start + size;
    if (end >= output.length) throw new CheckpointError("git-failed", "truncated cat-file body");
    objects.push({ type, content: new Uint8Array(output.subarray(start, end)) });
    offset = end + 1;
  }
  return objects;
}

/**
 * Refuse when ROOT is no longer the directory the agent started on.
 *
 * @param root - The canonical ROOT.
 * @param identity - The dev / ino recorded at start; undefined skips the check.
 * @throws {MachineRefusal} `internal` when the directory cannot be read or was replaced.
 *
 * @remarks
 * A write checks this through `applyVersionedWrite`; a checkpoint commits with git in ROOT, so
 * it checks the same way (INV-02). A replaced ROOT would otherwise snapshot a directory the
 * operator did not point the agent at.
 */
async function assertRootIdentity(root: string, identity: RootIdentity | undefined): Promise<void> {
  if (identity === undefined) return;
  const current = await stat(root).catch(() => undefined);
  if (current === undefined || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new MachineRefusal("internal", "ROOT is not the directory the agent started on");
  }
}

/**
 * Await one file system call, turning a passed deadline into the refusal.
 *
 * @param signal - The request's deadline.
 * @param work - The call to await.
 * @returns The call's value, once it settled and the deadline had not passed.
 * @throws {MachineRefusal} `deadline_exceeded` when the signal fired, either
 * before the call settled or because the call itself was aborted.
 *
 * @remarks
 * The promise is awaited, never abandoned: the caller keeps its concurrency slot
 * until the call settles, so a timed-out request cannot leave work running
 * behind a slot another request takes.
 */
async function bounded<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  try {
    const value = await work;
    signal.throwIfAborted();
    return value;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
}

/**
 * The errno a Node error carries, or "" when it is not one.
 *
 * @param error - The error caught around a file system call.
 * @returns The errno code; the field is read defensively because Node types it
 * loosely.
 */
function errnoOf(error: Error): string {
  return "code" in error ? String(error.code) : "";
}

/**
 * Translate a Node file error into the vocabulary the workspace already uses.
 *
 * @param error - The error caught around a file system call.
 * @param path - The path as the request named it, for the message.
 * @returns A FileFailure whose code says what to branch on. Anything
 * unrecognized is `unknown`, never a guess that looks like "not found".
 */
function fileFailure(error: Error, path: string): FileFailure {
  const errno = errnoOf(error);
  switch (errno) {
    case "ENOENT":
      return new FileFailure("not_found", `${path}: no such file or directory`);
    case "EACCES":
    case "EPERM":
      return new FileFailure("permission_denied", `${path}: permission denied`);
    case "EISDIR":
      return new FileFailure("is_directory", `${path}: is a directory`);
    case "ENOTDIR":
      return new FileFailure("not_directory", `${path}: not a directory`);
    case "ENXIO":
      return new FileFailure("invalid", `${path}: is not a regular file`);
    case "ELOOP":
      return new FileFailure("invalid", `${path}: symbolic link`);
  }
  return new FileFailure("unknown", `${path}: ${error.message}`);
}

/**
 * List one path's metadata without following a final symbolic link.
 *
 * @param absolute - The canonical absolute path.
 * @param relativePath - The path as the request named it, for the message.
 * @param signal - The request's deadline.
 * @returns The entry's metadata.
 * @throws {FileFailure} With the translated Node error.
 */
async function lstatPath(
  absolute: string,
  relativePath: string,
  signal: AbortSignal,
): Promise<Stats> {
  try {
    return await bounded(signal, lstat(absolute));
  } catch (error) {
    if (error instanceof MachineRefusal) throw error;
    if (!(error instanceof Error)) throw error;
    throw fileFailure(error, relativePath);
  }
}

/** The kind of one entry, from the metadata the call already holds. */
function kindOf(info: Stats): MachineFileKind {
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  if (info.isSymbolicLink()) return "symlink";
  return "other";
}

/** The kind of one directory entry, without following it. */
function kindOfEntry(entry: Dirent): MachineFileKind {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

/**
 * Report whether a path exists, without following a final symbolic link.
 *
 * @param root - The canonical root.
 * @param relativePath - The path from the request.
 * @param signal - The request's deadline.
 * @returns `{exists: false}` for a missing entry; otherwise its kind, size, and
 * modification time. A symbolic link is reported as `kind: "symlink"`, not
 * followed.
 * @throws {Denied} When the path cannot stay inside ROOT.
 * @throws {FileFailure} For any failure other than an absent entry.
 */
async function statPath(
  root: string,
  relativePath: string,
  signal: AbortSignal,
): Promise<StatResult> {
  const contained = await containInRoot(root, relativePath);
  signal.throwIfAborted();
  let info: Stats | undefined = undefined;
  try {
    info = await bounded(signal, lstat(contained.absolute));
  } catch (error) {
    if (error instanceof MachineRefusal) throw error;
    if (!(error instanceof Error)) throw error;
    if (errnoOf(error) !== "ENOENT") throw fileFailure(error, relativePath);
  }
  if (info === undefined) return { exists: false };
  return { exists: true, kind: kindOf(info), size: info.size, mtimeMs: info.mtimeMs };
}

/**
 * Read one regular file below ROOT.
 *
 * @param root - The canonical root.
 * @param relativePath - The path from the request.
 * @param limits - The response bound; a larger file is refused before it is read.
 * @param signal - The request's deadline; the read itself is aborted by it.
 * @returns The normalized path, byte size, sha256 version, and base64 content.
 * @throws {Denied} When the path cannot stay inside ROOT.
 * @throws {MachineRefusal} `too_large` over the response bound, `forbidden`
 * for a symbolic link, `invalid_request` for a FIFO, device, or socket,
 * `not_found` for a missing parent, `deadline_exceeded` after the deadline.
 * @throws {FileFailure} For any other file failure.
 *
 * @remarks
 * A non-regular file is refused before it is opened: opening a FIFO would block
 * a thread-pool thread, and the deadline could not reclaim it. The open also
 * refuses a final symbolic link and is non-blocking, so a swap after the check
 * still cannot wedge the read. The version is the sha256 of the bytes that were
 * read, the same `sha256:<hex>` spelling the workspace uses.
 */
async function readPath(
  root: string,
  relativePath: string,
  limits: Limits,
  signal: AbortSignal,
): Promise<ReadResult> {
  const contained = await containInRoot(root, relativePath);
  signal.throwIfAborted();
  const before = await lstatPath(contained.absolute, relativePath, signal);
  if (before.isSymbolicLink()) {
    throw new MachineRefusal("forbidden", `${relativePath}: the path is a symbolic link`);
  }
  if (!before.isFile()) {
    throw new MachineRefusal("invalid_request", `${relativePath}: is not a regular file`);
  }
  const handle = await open(
    contained.absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: Error) => {
    if (errnoOf(error) === "ELOOP") {
      throw new MachineRefusal("forbidden", `${relativePath}: the path is a symbolic link`);
    }
    if (errnoOf(error) === "ENXIO") {
      throw new MachineRefusal("invalid_request", `${relativePath}: is not a regular file`);
    }
    throw fileFailure(error, relativePath);
  });
  try {
    const opened = await bounded(signal, handle.stat());
    if (!opened.isFile()) {
      throw new MachineRefusal("invalid_request", `${relativePath}: is not a regular file`);
    }
    if (opened.size > limits.maxResponseBytes) {
      throw new MachineRefusal(
        "too_large",
        `${relativePath}: the file is larger than the response limit`,
      );
    }
    const bytes = await bounded(signal, handle.readFile({ signal }));
    return {
      path: contained.relative,
      size: bytes.byteLength,
      version: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      content: bytes.toString("base64"),
    };
  } catch (error) {
    if (error instanceof MachineRefusal || error instanceof FileFailure) throw error;
    if (!(error instanceof Error)) throw error;
    throw fileFailure(error, relativePath);
  } finally {
    await handle.close();
  }
}

/**
 * List one directory below ROOT, without following a final symbolic link.
 *
 * @param root - The canonical root.
 * @param relativePath - The path from the request.
 * @param signal - The request's deadline.
 * @returns The entries, in the order the file system returned them.
 * @throws {Denied} When the path cannot stay inside ROOT.
 * @throws {MachineRefusal} `forbidden` for a symbolic link, `invalid_request`
 * for an entry that is not a directory.
 * @throws {FileFailure} For any other file failure.
 *
 * @remarks
 * The final component is checked with `lstat` first, so a link is refused
 * instead of followed and directories outside ROOT stay unlisted. The window
 * between that check and the listing is the same residual race the parent check
 * has; the dirfd helper the workspace needs closes both.
 */
async function listPath(
  root: string,
  relativePath: string,
  signal: AbortSignal,
): Promise<ListResult> {
  const contained = await containInRoot(root, relativePath);
  signal.throwIfAborted();
  const info = await lstatPath(contained.absolute, relativePath, signal);
  if (info.isSymbolicLink()) {
    throw new MachineRefusal("forbidden", `${relativePath}: the path is a symbolic link`);
  }
  if (!info.isDirectory()) {
    throw new MachineRefusal("invalid_request", `${relativePath}: is not a directory`);
  }
  let entries: Dirent[];
  try {
    entries = await bounded(signal, readdir(contained.absolute, { withFileTypes: true }));
  } catch (error) {
    if (error instanceof MachineRefusal) throw error;
    if (!(error instanceof Error)) throw error;
    throw fileFailure(error, relativePath);
  }
  return { entries: entries.map((entry) => ({ name: entry.name, kind: kindOfEntry(entry) })) };
}
/**
 * Refuse a file-system failure with the machine's closed vocabulary.
 *
 * @param failure - A failure raised before the write touched the target.
 * @returns The refusal with the same meaning: absence is 404, a permission
 * problem is 403, a request that cannot be honored is 400, and a broken root or
 * an undecidable I/O failure is `internal` (never a success).
 */
function refusalForFileSystem(failure: FileSystemFailure): MachineRefusal {
  switch (failure.code) {
    case "not_found":
      return new MachineRefusal("not_found", failure.message);
    case "permission_denied":
      return new MachineRefusal("forbidden", failure.message);
    case "too_large":
      return new MachineRefusal("too_large", failure.message);
    case "is_directory":
    case "not_directory":
    case "invalid":
    case "exists":
      return new MachineRefusal("invalid_request", failure.message);
    default:
      return new MachineRefusal("internal", failure.message);
  }
}

/**
 * Apply one versioned write below ROOT.
 *
 * @param operation - The parsed write: the project, the path, the bytes, and
 * the version the writer saw.
 * @param root - The canonical ROOT.
 * @param identity - The root's dev / ino recorded at start.
 * @param signal - The request's deadline.
 * @returns The mutation result plus the normalized path.
 * @throws {MachineRefusal} `invalid_request` for an unsafe path, an empty
 * project root, or bytes that do not match the intent hash; `not_found` for a
 * missing parent; `forbidden` for a symbolic link component; `deadline_exceeded`
 * once the deadline passes; `internal` for a replaced root or an undecidable
 * I/O failure.
 * @throws {Denied} When a component cannot stay inside ROOT.
 *
 * @remarks
 * The write is anchored to directory fds (see `@hns/workspace`'s
 * `applyVersionedWrite`): `projectRoot` and `path` are validated separately,
 * the target is re-hashed, and the replacement is a temp in the same directory
 * renamed from the held parent. The refusal is decided before anything is
 * written, so a caller can treat every thrown refusal as "not applied".
 */
async function writePath(
  operation: MachineWriteRequest,
  root: string,
  identity: RootIdentity | undefined,
  signal: AbortSignal,
): Promise<MachineWriteResult> {
  signal.throwIfAborted();
  const content = Buffer.from(operation.content, "base64");
  try {
    const outcome = await withWriteLock(
      root + "\0" + operation.projectRoot + "\0" + operation.path,
      () =>
        applyVersionedWrite({
          root,
          identity,
          projectRoot: operation.projectRoot,
          path: operation.path,
          content,
          expectedVersion: operation.expectedVersion,
          contentHash: operation.contentHash,
          signal,
        }),
    );
    // The intent id is the Worker's journal key: the write never uses it as a path.
    return { ...outcome, operationId: operation.operationId };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error instanceof MachineRefusal) throw error;
    if (error instanceof FileSystemFailure) throw refusalForFileSystem(error);
    throw error;
  }
}
