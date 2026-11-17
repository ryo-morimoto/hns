import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { Dirent } from "node:fs";
import { FileFailure, FileSystemFailure, applyVersionedWrite } from "@hns/workspace";
import type { RootIdentity } from "@hns/workspace";
import type { MachineWriteRequest, MachineWriteResult } from "@hns/core";
import { containInRoot } from "./containment.ts";
import type { Limits } from "./limits.ts";
import { MachineRefusal } from "./refusal.ts";
import type {
  HealthResult,
  ListResult,
  MachineFileKind,
  Operation,
  ReadResult,
  StatResult,
} from "./wire.ts";

/** The result of any operation, before it is serialized. */
export type OperationResult =
  | HealthResult
  | StatResult
  | ReadResult
  | ListResult
  | MachineWriteResult;

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
 * once the deadline passes.
 * @throws {FileFailure} With pi-durable's codes for any other file failure, so
 * the caller branches on a code instead of a message.
 */
export async function runOperation(
  operation: Operation,
  root: string,
  limits: Limits,
  signal: AbortSignal,
  identity?: RootIdentity | undefined,
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
  }
  const unreachable: never = operation;
  return unreachable;
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
    const outcome = await applyVersionedWrite({
      root,
      identity,
      projectRoot: operation.projectRoot,
      path: operation.path,
      content,
      expectedVersion: operation.expectedVersion,
      contentHash: operation.contentHash,
      signal,
    });
    // The intent id is the Worker's journal key: the write never uses it as a path.
    return { ...outcome, operationId: operation.operationId };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error instanceof MachineRefusal) throw error;
    if (error instanceof FileSystemFailure) throw refusalForFileSystem(error);
    throw error;
  }
}
