import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { FileFailure } from "@hns/workspace";
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
export type OperationResult = HealthResult | StatResult | ReadResult | ListResult;

/**
 * Run one operation against ROOT.
 *
 * @param operation - The parsed operation from the request.
 * @param root - The canonical root; every path is resolved below it.
 * @param limits - The response bound, so a large file is refused before it is read.
 * @returns The operation's result, ready to serialize.
 * @throws {Denied} When the path cannot stay inside ROOT.
 * @throws {MachineRefusal} `not_found` for a missing parent, `too_large` for a
 * file over the response bound, `forbidden` for a symbolic link as the final
 * component of a read.
 * @throws {FileFailure} With pi-durable's codes for any other file failure, so
 * the caller branches on a code instead of a message.
 */
export async function runOperation(
  operation: Operation,
  root: string,
  limits: Limits,
): Promise<OperationResult> {
  switch (operation.op) {
    case "health":
      return { root, pid: process.pid };
    case "stat":
      return await statPath(root, operation.path);
    case "read":
      return await readPath(root, operation.path, limits);
    case "list":
      return await listPath(root, operation.path);
  }
  const unreachable: never = operation;
  return unreachable;
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
    case "ELOOP":
      return new FileFailure("invalid", `${path}: symbolic link`);
  }
  return new FileFailure("unknown", `${path}: ${error.message}`);
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
 * @returns `{exists: false}` for a missing entry; otherwise its kind, size, and
 * modification time.
 * @throws {Denied} When the path cannot stay inside ROOT.
 * @throws {FileFailure} For any failure other than an absent entry.
 */
async function statPath(root: string, relativePath: string): Promise<StatResult> {
  const contained = await containInRoot(root, relativePath);
  const info = await lstat(contained.absolute).catch((error: Error) => {
    if (errnoOf(error) === "ENOENT") return undefined;
    throw fileFailure(error, relativePath);
  });
  if (info === undefined) return { exists: false };
  return { exists: true, kind: kindOf(info), size: info.size, mtimeMs: info.mtimeMs };
}

/**
 * Read one regular file below ROOT.
 *
 * @param root - The canonical root.
 * @param relativePath - The path from the request.
 * @param limits - The response bound; a larger file is refused before it is read.
 * @returns The normalized path, byte size, sha256 version, and base64 content.
 * @throws {Denied} When the path cannot stay inside ROOT.
 * @throws {MachineRefusal} `too_large` over the response bound, `forbidden`
 * when the final component is a symbolic link, `not_found` for a missing parent.
 * @throws {FileFailure} For any other file failure.
 *
 * @remarks
 * The open refuses a final symbolic link, so a link cannot serve bytes from
 * outside ROOT even when its parent is inside. The version is the sha256 of the
 * bytes that were read, the same `sha256:<hex>` spelling the workspace uses.
 */
async function readPath(root: string, relativePath: string, limits: Limits): Promise<ReadResult> {
  const contained = await containInRoot(root, relativePath);
  const handle = await open(contained.absolute, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: Error) => {
      if (errnoOf(error) === "ELOOP") {
        throw new MachineRefusal("forbidden", `${relativePath}: the path is a symbolic link`);
      }
      throw fileFailure(error, relativePath);
    },
  );
  try {
    const info = await handle.stat();
    if (info.isDirectory())
      throw new FileFailure("is_directory", `${relativePath}: is a directory`);
    if (!info.isFile()) throw new FileFailure("invalid", `${relativePath}: is not a regular file`);
    if (info.size > limits.maxResponseBytes) {
      throw new MachineRefusal(
        "too_large",
        `${relativePath}: the file is larger than the response limit`,
      );
    }
    const bytes = await handle.readFile();
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
 * List one directory below ROOT.
 *
 * @param root - The canonical root.
 * @param relativePath - The path from the request.
 * @returns The entries, in the order the file system returned them.
 * @throws {Denied} When the path cannot stay inside ROOT.
 * @throws {FileFailure} `not_directory` when the path is not a directory, or any
 * other file failure.
 */
async function listPath(root: string, relativePath: string): Promise<ListResult> {
  const contained = await containInRoot(root, relativePath);
  const entries = await readdir(contained.absolute, { withFileTypes: true }).catch(
    (error: Error) => {
      throw fileFailure(error, relativePath);
    },
  );
  return { entries: entries.map((entry) => ({ name: entry.name, kind: kindOfEntry(entry) })) };
}
