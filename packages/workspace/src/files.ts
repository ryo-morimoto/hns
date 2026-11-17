// The file-system primitives shared by the rooted helper and the machine agent.
//
// A path passed to open(2) or rename(2) is re-resolved at every component, so a
// parent swapped between the check and the use redirects the operation. Holding
// one directory fd per component and resolving the next name below it closes
// that window ("openat semantics"): the kernel resolves against the held
// directory, not against the path. Node exposes this through /proc/self/fd.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

// O_NOFOLLOW on every directory keeps a symbolic link from redirecting the walk.
export const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// O_NONBLOCK keeps a FIFO from blocking the open, as pi-durable's reader does.
export const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** The chunk a hash reads at a time, so size does not bound the work. */
const HASH_CHUNK = 1 << 20;

/**
 * A failure carrying the code vocabulary the caller maps to Denied, FileFailure,
 * or a machine refusal.
 *
 * @remarks
 * The codes are the ones the rooted helper already reports (`not_found`,
 * `is_directory`, `invalid`, `root_replaced`, ...). A caller must branch on
 * `code`, never on the message.
 */
export class FileSystemFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FileSystemFailure";
    this.code = code;
  }
}

/**
 * Throw a {@link FileSystemFailure}.
 *
 * @param code - The failure code.
 * @param message - A diagnostic message with no secret and no content.
 * @throws {FileSystemFailure} Always.
 */
export function fail(code: string, message: string): never {
  throw new FileSystemFailure(code, message);
}

const CODE_BY_ERRNO = new Map<string, string>([
  ["ENOENT", "not_found"],
  ["ENOTDIR", "not_directory"],
  ["ELOOP", "invalid"],
  ["EACCES", "permission_denied"],
  ["EPERM", "permission_denied"],
  ["EEXIST", "exists"],
  ["EXDEV", "cross_device"],
  ["ENAMETOOLONG", "invalid"],
]);

/**
 * Run one file system call, reporting the errno the way the callers expect.
 *
 * @param work - The call to run.
 * @param name - The path component or operation named in the message.
 * @returns The call's value.
 * @throws {FileSystemFailure} With a code from the known errno map, or `io`
 * when the errno is one this module does not know.
 */
export async function attempt<T>(work: () => Promise<T>, name: string): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof Error)) fail("io", name + ": unknown failure");
    const errno = "code" in error ? String(error.code) : "";
    fail(CODE_BY_ERRNO.get(errno) ?? "io", name + ": " + error.message);
  }
}

/**
 * The path that gives Node openat(2) semantics: a name resolved below a live fd.
 *
 * @param fd - The held directory fd.
 * @param name - One component to resolve below it.
 * @returns The pseudo-path the kernel resolves against the held directory.
 */
export function procFd(fd: number, name: string): string {
  return "/proc/self/fd/" + fd + "/" + name;
}

/**
 * Open `name` below `dirFd` with `flags`.
 *
 * @param dirFd - The directory to resolve against; `name` is one component.
 * @param name - The component to open.
 * @param flags - The open flags, from {@link DIR_FLAGS} or {@link FILE_FLAGS}.
 * @returns The open handle; the caller closes it.
 * @throws {FileSystemFailure} When the open fails.
 */
export function openAt(dirFd: number, name: string, flags: number): Promise<FileHandle> {
  return attempt(() => open(procFd(dirFd, name), flags), name);
}

/**
 * Directory handles for every component, the last one being the target's parent.
 *
 * @param root - The already-pinned root handle.
 * @param names - The parent components, outermost first.
 * @returns The parent's handle, or undefined when the target sits directly in
 * the root. Intermediate handles are closed as the walk advances, and the walk
 * stops at the first component that is not a real directory (`O_NOFOLLOW`).
 * @throws {FileSystemFailure} When a component is missing, is not a directory,
 * or is a symbolic link.
 */
export async function openParentChain(
  root: FileHandle,
  names: readonly string[],
): Promise<FileHandle | undefined> {
  let parent: FileHandle | undefined;
  let fd = root.fd;
  try {
    for (const name of names) {
      const next = await openAt(fd, name, DIR_FLAGS);
      if (parent !== undefined) await parent.close();
      parent = next;
      fd = next.fd;
    }
    return parent;
  } catch (error) {
    if (parent !== undefined) await parent.close();
    throw error;
  }
}

/**
 * Open the target below the pinned parent (or the root, when the target has no
 * parent below it).
 *
 * @param root - The pinned root handle.
 * @param parent - The target's parent, or undefined when it sits in the root.
 * @param name - The final component.
 * @returns The open handle; the caller closes it.
 * @throws {FileSystemFailure} When the open fails.
 *
 * @remarks
 * `O_NOFOLLOW` refuses a final symbolic link and `O_NONBLOCK` keeps a FIFO from
 * blocking the open; {@link expectRegular} then rejects anything that is not a
 * file.
 */
export function openTarget(
  root: FileHandle,
  parent: FileHandle | undefined,
  name: string,
): Promise<FileHandle> {
  const fd = parent === undefined ? root.fd : parent.fd;
  return attempt(() => open(procFd(fd, name), FILE_FLAGS), name);
}

/**
 * Refuse anything that is not a regular file.
 *
 * @param file - An open handle.
 * @returns The file's size in bytes, for the caller to bound its read.
 * @throws {FileSystemFailure} `is_directory` for a directory and `invalid` for
 * any other file type, so a device or FIFO cannot stand in for a document.
 */
export async function expectRegular(file: FileHandle): Promise<number> {
  const stat = await file.stat();
  if (stat.isDirectory()) fail("is_directory", "is a directory");
  if (!stat.isFile()) fail("invalid", "not a regular file");
  return stat.size;
}

/**
 * Hash an open file's content, streaming so size does not bound the work.
 *
 * @param file - An open regular file.
 * @returns The version string, `"sha256:<hex>"`, over the whole content.
 */
export async function hashFile(file: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_CHUNK);
  let offset = 0;
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, HASH_CHUNK, offset);
    if (bytesRead === 0) return "sha256:" + hash.digest("hex");
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
}

/**
 * The version of the named file, or `"absent"` when the name is free.
 *
 * @param root - The pinned root handle.
 * @param parent - The target's parent, or undefined when it sits in the root.
 * @param name - The final component.
 * @returns The `sha256:<hex>` version, or `"absent"`.
 * @throws {FileSystemFailure} For any failure other than a missing name; a
 * permission error must not read as an absent file.
 */
export async function versionAt(
  root: FileHandle,
  parent: FileHandle | undefined,
  name: string,
): Promise<string> {
  let file: FileHandle;
  try {
    file = await openTarget(root, parent, name);
  } catch (error) {
    if (error instanceof FileSystemFailure && error.code === "not_found") return "absent";
    throw error;
  }
  try {
    await expectRegular(file);
    return await hashFile(file);
  } finally {
    await file.close();
  }
}

/**
 * Validate a request's path as component names.
 *
 * @param path - The names below the root, outermost first.
 * @returns The same names, once every one is a single real component.
 * @throws {FileSystemFailure} `invalid` for an empty path, `.`, `..`, a name
 * containing `/` or NUL, or an empty name.
 *
 * @remarks
 * A request crosses a process boundary (the helper) or a network boundary (the
 * machine agent), so the receiver re-checks this even when the sender
 * normalized the path.
 */
export function namesOf(path: readonly string[]): readonly string[] {
  if (path.length === 0) fail("invalid", "path is empty");
  for (const name of path) {
    if (name === "" || name === "." || name === "..") fail("invalid", "bad path component");
    if (name.includes("/") || name.includes("\0")) fail("invalid", "bad path component");
  }
  return path;
}
