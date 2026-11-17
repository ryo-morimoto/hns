// The file-system primitives shared by the rooted helper and the machine agent.
//
// A path passed to open(2) or rename(2) is re-resolved at every component, so a
// parent swapped between the check and the use redirects the operation. Holding
// one directory fd per component and resolving the next name below it closes
// that window ("openat semantics"): the kernel resolves against the held
// directory, not against the path. Node exposes this through /proc/self/fd.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
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
async function hashFile(file: FileHandle): Promise<string> {
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
/**
 * Split one wire path into component names, refusing anything that could climb.
 *
 * @param value - The path as the request wrote it; both separators are accepted.
 * @returns The components, without empty or `.` segments.
 * @throws {FileSystemFailure} `invalid` for a NUL, a POSIX-absolute path, a
 * Windows drive letter, or any `..` segment.
 *
 * @remarks
 * This is the syntactic half of the containment: `..` is refused rather than
 * resolved, so the names cannot climb out of the directory they are joined to.
 * The walk below opens each name against a held fd, which is the other half.
 */
function componentNames(value: string): readonly string[] {
  if (value.includes("\0")) fail("invalid", "invalid path");
  if (value.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(value)) fail("invalid", "absolute path");
  const parts = value.split(/[\\/]+/u);
  if (parts.includes("..")) fail("invalid", "parent segment");
  return parts.filter((part) => part !== "" && part !== ".");
}

/**
 * Join a project root and a file path into the names below ROOT.
 *
 * @param projectRoot - The project directory below ROOT; `""` names ROOT itself.
 * @param path - The file below the project root; it must name at least one name.
 * @returns The components to walk, project root first.
 * @throws {FileSystemFailure} `invalid` when either part is unsafe or the path
 * is empty.
 *
 * @remarks
 * The two parts are validated **separately**, so a `path` cannot leave its
 * project and a `projectRoot` cannot leave ROOT, even when one is prefixed with
 * the other.
 */
function projectNames(projectRoot: string, path: string): readonly string[] {
  const project = componentNames(projectRoot);
  const file = componentNames(path);
  if (file.length === 0) fail("invalid", "path is empty");
  return [...project, ...file];
}

/**
 * The version of some bytes: their sha256, in the one spelling the workspace uses.
 *
 * @param bytes - The content to hash.
 * @returns `"sha256:<hex>"`.
 */
export function versionOf(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

/** What one versioned write did, as the machine reports it. */
export type WriteOutcome =
  | { readonly status: "applied"; readonly path: string; readonly version: string }
  | { readonly status: "conflict"; readonly path: string; readonly currentVersion: string }
  | { readonly status: "unknown"; readonly path: string; readonly reason: "io" };

/** The pinned root: the canonical directory and the dev / inode it had at start. */
export interface RootIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** One versioned write below a pinned root. */
export interface VersionedWriteInput {
  /** The canonical ROOT; every path resolves below it. */
  readonly root: string;
  /** The root's dev / ino recorded at start; a different directory fails closed. */
  readonly identity?: RootIdentity | undefined;
  /** The project directory below ROOT; validated separately from `path`. */
  readonly projectRoot: string;
  /** The file below the project root. */
  readonly path: string;
  /** The bytes to write. */
  readonly content: Uint8Array;
  /** The version the writer saw, or `"absent"`. */
  readonly expectedVersion: string;
  /** The intent's hash; the bytes must hash to it before anything is written. */
  readonly contentHash: string;
  /** The request's deadline; checked before the write and before the rename. */
  readonly signal?: AbortSignal | undefined;
  /** Test hook: run right before the rename, where a racer acts. */
  readonly beforeRename?: (() => Promise<void> | void) | undefined;
}

/** The temp name is internal: the operation id is a journal key, never a path. */
const tempName = (): string => ".hns-tmp-" + randomUUID();

/**
 * Replace one file if it is still at `expectedVersion`, from one pinned parent.
 *
 * @param input - The pinned root, the project and path, the bytes, and the
 * version the writer saw.
 * @returns `applied` with the new version, `conflict` with what is there now,
 * or `unknown` when the result cannot be confirmed after the rename.
 * @throws {FileSystemFailure} With the errno-mapped code for a refusal or a
 * failure before the write (`invalid`, `not_found`, `is_directory`,
 * `permission_denied`, `io`). Nothing is written in that case.
 *
 * @remarks
 * The order is the one docs/durability.md §3.1 gives: resolve the parent with
 * `O_NOFOLLOW` per component, recompute the target's version, compare it, write
 * a temp **in the same directory**, fsync it, then rename it below the same held
 * parent. The same-name swap between the hash and the rename is the residual
 * window Linux cannot close (no compare-and-rename); everything before it is
 * anchored to fds. A target whose bytes already equal the content is `applied`
 * without a write, which is how a retry after a crash settles.
 */
export async function applyVersionedWrite(input: VersionedWriteInput): Promise<WriteOutcome> {
  const names = projectNames(input.projectRoot, input.path);
  const normalized = names.join("/");
  if (versionOf(input.content) !== input.contentHash) {
    fail("invalid", "content does not match the intent hash");
  }
  let rootHandle: FileHandle;
  try {
    rootHandle = await open(input.root, DIR_FLAGS);
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    throw new FileSystemFailure(
      missing ? "root_missing" : "root_replaced",
      "the root cannot be opened",
    );
  }
  try {
    if (input.identity !== undefined) {
      const stat = await rootHandle.stat();
      if (stat.dev !== input.identity.dev || stat.ino !== input.identity.ino) {
        fail("root_replaced", "root is a different directory");
      }
    }
    const parent = await openParentChain(rootHandle, names.slice(0, -1));
    try {
      const name = names[names.length - 1] ?? "";
      const current = await versionAt(rootHandle, parent, name);
      if (current === input.contentHash) {
        return { status: "applied", path: normalized, version: current };
      }
      if (current !== input.expectedVersion) {
        return { status: "conflict", path: normalized, currentVersion: current };
      }
      const fd = parent === undefined ? rootHandle.fd : parent.fd;
      const temp = tempName();
      await writeTemp(fd, temp, input.content);
      try {
        input.signal?.throwIfAborted();
        if (input.beforeRename !== undefined) await input.beforeRename();
        await attempt(() => rename(procFd(fd, temp), procFd(fd, name)), name);
      } catch (error) {
        await removeTemp(fd, temp);
        throw error;
      }
      // A same-name swap after the rename leaves bytes the intent does not name.
      const after = await versionAt(rootHandle, parent, name);
      if (after !== input.contentHash) {
        return { status: "unknown", path: normalized, reason: "io" };
      }
      return { status: "applied", path: normalized, version: after };
    } finally {
      if (parent !== undefined) await parent.close();
    }
  } finally {
    await rootHandle.close();
  }
}

/** Write one temp file below the pinned parent and flush it. */
async function writeTemp(dirFd: number, name: string, content: Uint8Array): Promise<void> {
  const handle = await attempt(() => open(procFd(dirFd, name), "wx", 0o666), name);
  try {
    await attempt(() => handle.writeFile(content), name);
    await attempt(() => handle.sync(), name);
  } catch (error) {
    await handle.close();
    await removeTemp(dirFd, name);
    throw error;
  }
  await handle.close();
}

/** Remove a temp file, ignoring a missing one. */
async function removeTemp(dirFd: number, name: string): Promise<void> {
  try {
    await unlink(procFd(dirFd, name));
  } catch {
    // The temp is already gone; the write's own result is what matters.
  }
}
