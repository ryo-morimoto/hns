// A helper process that opens and renames from a directory fd, so swapping a
// parent directory cannot redirect the operation outside the root.
//
// ExecutionEnv's file API takes paths only, and rename(2) re-resolves every
// component; Linux gives openat semantics through /proc/self/fd. The workspace
// runs this file through exec(), one process per operation, and keeps the older
// path-based checks where that is not possible (docs/workspace.md).
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { parseMarker, parseRequest } from "./protocol.ts";
import type { HelperReply, HelperRequest } from "./protocol.ts";

/** Largest file the read op returns; above it the op fails as `too_large`. */
const MAX_READ = 8 * 1024 * 1024;
const CHUNK = 1 << 20;
// O_NOFOLLOW on every directory keeps a symbolic link from redirecting the walk.
const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// O_NONBLOCK keeps a FIFO from blocking the open, as pi-durable's reader does.
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * The path that gives Node openat(2) semantics: a name resolved below a live fd.
 *
 * @remarks
 * ExecutionEnv's file API takes only paths, so the helper opens the root and
 * each parent once and then opens below the held fd. The kernel resolves the
 * name against that directory, not against a path that may have been swapped.
 */
const procFd = (fd: number, name: string): string => "/proc/self/fd/" + fd + "/" + name;

/** A failure carrying the code vocabulary the workspace maps to Denied or FileFailure. */
class Failure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "Failure";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new Failure(code, message);
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
 * Run one file system call, reporting the errno the way the workspace expects.
 *
 * @param work - The call to run.
 * @param name - The path component or operation named in the message.
 * @returns The call's value.
 * @throws {Failure} With a code from `CODE_BY_ERRNO`, or `io` when the errno
 * is not one the workspace knows.
 */
async function attempt<T>(work: () => Promise<T>, name: string): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof Error)) fail("io", name + ": unknown failure");
    const errno = "code" in error ? String(error.code) : "";
    fail(CODE_BY_ERRNO.get(errno) ?? "io", name + ": " + error.message);
  }
}

/**
 * Open `name` below `dirFd` with `flags`, so the name is resolved against the
 * held directory and not re-walked from `/`.
 *
 * @returns The open handle; the caller closes it.
 * @throws {Failure} When the open fails.
 */
function openAt(dirFd: number, name: string, flags: number): Promise<FileHandle> {
  return attempt(() => open(procFd(dirFd, name), flags), name);
}

/**
 * Read the id from `.hns/root.json` below the root dirfd.
 *
 * @returns The marker id, or undefined when the directory or file is absent.
 * A missing marker is not an error at this layer; the caller compares the result
 * with the expected id and fails closed.
 */
async function readMarker(rootFd: number): Promise<string | undefined> {
  let dir: FileHandle;
  try {
    dir = await openAt(rootFd, ".hns", DIR_FLAGS);
  } catch (error) {
    if (error instanceof Failure && error.code === "not_found") return undefined;
    throw error;
  }
  try {
    let file: FileHandle;
    try {
      file = await openAt(dir.fd, "root.json", FILE_FLAGS);
    } catch (error) {
      if (error instanceof Failure && error.code === "not_found") return undefined;
      throw error;
    }
    try {
      return parseMarker(await file.readFile("utf8"));
    } finally {
      await file.close();
    }
  } finally {
    await dir.close();
  }
}

/**
 * The root as a directory fd, after checking it is still the one we opened.
 *
 * @remarks
 * Two checks pin the root: the recorded `dev`/`ino` must match the directory
 * opened now, and the marker below that fd must name the journal's id. A root
 * that was replaced or remounted fails closed as `root_replaced`; one that no
 * longer exists is `root_missing`. The handle is closed on every failure path,
 * so a refused call leaks no fd.
 */
async function openRoot(request: HelperRequest): Promise<FileHandle> {
  let root: FileHandle;
  try {
    root = await open(request.root, DIR_FLAGS);
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    throw new Failure(missing ? "root_missing" : "root_replaced", "the root cannot be opened");
  }
  try {
    const stat = await root.stat();
    const dev = request.dev;
    const ino = request.ino;
    const moved = dev !== undefined && (stat.dev !== dev || stat.ino !== ino);
    if (moved) fail("root_replaced", "root is a different directory");
    const marker = await readMarker(root.fd);
    if (marker !== request.id) fail("root_replaced", "root marker does not match");
    return root;
  } catch (error) {
    await root.close();
    throw error;
  }
}

/**
 * Directory handles for every component, the last one being the target's parent.
 *
 * @param root - The already-pinned root handle.
 * @param names - The parent components, outermost first.
 * @returns The parent's handle, or undefined when the target sits directly in
 * the root. Intermediate handles are closed as the walk advances, and the walk
 * stops at the first component that is not a real directory (`O_NOFOLLOW`).
 */
async function openParentChain(
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
 * Open the target itself below the pinned parent (or the root, when the target
 * has no parent below it).
 *
 * @remarks
 * `O_NOFOLLOW` refuses a final symbolic link and `O_NONBLOCK` keeps a FIFO from
 * blocking the open; `expectRegular` then rejects anything that is not a file.
 */
function openTarget(
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
 * @returns The file's size in bytes, for the caller to bound its read.
 * @throws {Failure} `is_directory` for a directory and `invalid` for any other
 * file type, so a device or FIFO cannot stand in for a document.
 */
async function expectRegular(file: FileHandle): Promise<number> {
  const stat = await file.stat();
  if (stat.isDirectory()) fail("is_directory", "is a directory");
  if (!stat.isFile()) fail("invalid", "not a regular file");
  return stat.size;
}

/**
 * Hash an open file's content, streaming so size does not bound the work.
 *
 * @returns The version string, `"sha256:<hex>"`, over the whole content.
 */
async function hashFile(file: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK);
  let offset = 0;
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, CHUNK, offset);
    if (bytesRead === 0) return "sha256:" + hash.digest("hex");
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
}

/**
 * The version of the named file, or "absent" when the name is free.
 *
 * @throws {Failure} For any failure other than a missing name; a permission
 * error must not read as an absent file.
 */
async function versionAt(
  root: FileHandle,
  parent: FileHandle | undefined,
  name: string,
): Promise<string> {
  let file: FileHandle;
  try {
    file = await openTarget(root, parent, name);
  } catch (error) {
    if (error instanceof Failure && error.code === "not_found") return "absent";
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
 * @throws {Failure} `invalid` for an empty path, `.`, `..`, a name containing
 * "/" or NUL, or an empty name. The helper re-checks this even though the
 * workspace normalized the path: the request crosses a process boundary.
 */
function namesOf(path: readonly string[]): readonly string[] {
  if (path.length === 0) fail("invalid", "path is empty");
  for (const name of path) {
    if (name === "" || name === "." || name === "..") fail("invalid", "bad path component");
    if (name.includes("/") || name.includes("\0")) fail("invalid", "bad path component");
  }
  return path;
}

/**
 * Dispatch one request against the pinned root.
 *
 * @remarks
 * `commit` hashes the current target, compares it with `expectedVersion`, and
 * only then renames. Both steps use the same parent dirfd, which closes the
 * swapped-parent window; the same-name swap between the hash and the rename is
 * the residual window, and `unknown` covers what cannot be decided. `temp`
 * must be one component because the rename starts at the root dirfd.
 */
async function run(request: HelperRequest): Promise<HelperReply> {
  if (request.op === "probe") {
    return probe(request);
  }
  const path = namesOf(request.path);
  const root = await openRoot(request);
  try {
    if (request.op === "commit" && (request.temp === "" || request.temp.includes("/"))) {
      fail("invalid", "bad temp name");
    }
    const parent = await openParentChain(root, path.slice(0, -1));
    try {
      const name = path[path.length - 1] ?? "";
      if (request.op === "hash") return { ok: true, version: await versionAt(root, parent, name) };
      if (request.op === "commit") {
        const current = await versionAt(root, parent, name);
        if (current !== request.expectedVersion) {
          return { ok: true, status: "conflict", currentVersion: current };
        }
        const target = procFd(parent === undefined ? root.fd : parent.fd, name);
        await attempt(() => rename(procFd(root.fd, request.temp), target), "rename");
        return { ok: true, status: "applied" };
      }
      const content = await readContent(root, parent, name);
      return { ok: true, base64: content.base64, size: content.size };
    } finally {
      if (parent !== undefined) await parent.close();
    }
  } finally {
    await root.close();
  }
}

/**
 * Prove the root opens and is the one the caller pinned.
 *
 * @returns The root's `dev`/`ino`, for the workspace to send with later calls.
 * @throws {Failure} `root_missing` or `root_replaced`, as any other op would.
 */
async function probe(request: HelperRequest): Promise<HelperReply> {
  const root = await openRoot(request);
  try {
    const stat = await root.stat();
    return { ok: true, dev: stat.dev, ino: stat.ino };
  } finally {
    await root.close();
  }
}

/**
 * Read a regular file's content, bounded by `MAX_READ`.
 *
 * @returns The content as base64, because stdout is the only reply channel, and
 * the number of bytes encoded, so the client can detect a cut reply.
 * @throws {Failure} `too_large` above 8 MiB, so one read cannot exhaust the
 * pipe or the caller's memory.
 */
async function readContent(
  root: FileHandle,
  parent: FileHandle | undefined,
  name: string,
): Promise<{ readonly base64: string; readonly size: number }> {
  const file = await openTarget(root, parent, name);
  try {
    const size = await expectRegular(file);
    if (size > MAX_READ) fail("too_large", "file is larger than " + MAX_READ + " bytes");
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await file.read(buffer, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { base64: buffer.subarray(0, offset).toString("base64"), size: offset };
  } finally {
    await file.close();
  }
}

/**
 * Entry point: `rooted-helper <op> <json>` prints one JSON reply on stdout.
 *
 * @remarks
 * A failure is printed as `{ ok: false, code, message }` and the exit status
 * stays 0, because the client reads the reply and a non-zero exit would be
 * indistinguishable from a helper that never ran. Usage errors exit 2.
 */
async function main(): Promise<void> {
  const [op, payload] = process.argv.slice(2);
  if (op === undefined || payload === undefined) {
    process.stderr.write("rooted-helper <probe|hash|read|commit> <json>\n");
    process.exitCode = 2;
    return;
  }
  let reply: HelperReply;
  try {
    reply = await run(parseRequest(payload));
  } catch (error) {
    reply =
      error instanceof Failure
        ? { ok: false, code: error.code, message: error.message }
        : {
            ok: false,
            code: "io",
            message: error instanceof Error ? error.message : "unknown failure",
          };
  }
  process.stdout.write(JSON.stringify(reply));
}

await main();
