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

const MAX_READ = 8 * 1024 * 1024;
const CHUNK = 1 << 20;
const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// O_NONBLOCK keeps a FIFO from blocking the open, as pi-durable's reader does.
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const procFd = (fd: number, name: string): string => "/proc/self/fd/" + fd + "/" + name;

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

/** Run one file system call, reporting the errno the way the workspace expects. */
async function attempt<T>(work: () => Promise<T>, name: string): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof Error)) fail("io", name + ": unknown failure");
    const errno = "code" in error ? String(error.code) : "";
    fail(CODE_BY_ERRNO.get(errno) ?? "io", name + ": " + error.message);
  }
}

function openAt(dirFd: number, name: string, flags: number): Promise<FileHandle> {
  return attempt(() => open(procFd(dirFd, name), flags), name);
}

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

/** The root as a directory fd, after checking it is still the one we opened. */
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

/** Directory handles for every component, the last one being the target's parent. */
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

function openTarget(
  root: FileHandle,
  parent: FileHandle | undefined,
  name: string,
): Promise<FileHandle> {
  const fd = parent === undefined ? root.fd : parent.fd;
  return attempt(() => open(procFd(fd, name), FILE_FLAGS), name);
}

async function expectRegular(file: FileHandle): Promise<number> {
  const stat = await file.stat();
  if (stat.isDirectory()) fail("is_directory", "is a directory");
  if (!stat.isFile()) fail("invalid", "not a regular file");
  return stat.size;
}

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

/** The version of the named file, or "absent" when the name is free. */
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

function namesOf(path: readonly string[]): readonly string[] {
  if (path.length === 0) fail("invalid", "path is empty");
  for (const name of path) {
    if (name === "" || name === "." || name === "..") fail("invalid", "bad path component");
    if (name.includes("/") || name.includes("\0")) fail("invalid", "bad path component");
  }
  return path;
}

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
      return { ok: true, base64: await readContent(root, parent, name) };
    } finally {
      if (parent !== undefined) await parent.close();
    }
  } finally {
    await root.close();
  }
}

async function probe(request: HelperRequest): Promise<HelperReply> {
  const root = await openRoot(request);
  try {
    const stat = await root.stat();
    return { ok: true, dev: stat.dev, ino: stat.ino };
  } finally {
    await root.close();
  }
}

async function readContent(
  root: FileHandle,
  parent: FileHandle | undefined,
  name: string,
): Promise<string> {
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
    return buffer.subarray(0, offset).toString("base64");
  } finally {
    await file.close();
  }
}

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
