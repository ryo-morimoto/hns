// A helper process that opens and renames from a directory fd, so swapping a
// parent directory cannot redirect the operation outside the root.
//
// ExecutionEnv's file API takes paths only, and rename(2) re-resolves every
// component; Linux gives openat semantics through /proc/self/fd. The workspace
// runs this file through exec(), one process per operation. When exec or
// /proc/self/fd is unavailable the workspace keeps the older check-and-hope
// path; see docs/workspace.md ("TOCTOU").
import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";
import { createHash } from "node:crypto";

const MAX_READ = 8 * 1024 * 1024;
const CHUNK = 1 << 20;
const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// O_NONBLOCK keeps a FIFO from blocking the open, as pi-durable's reader does.
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const procFd = (fd, name) => "/proc/self/fd/" + fd + "/" + name;

class Failure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new Failure(code, message);
};

const CODE_BY_ERRNO = {
  ENOENT: "not_found",
  ENOTDIR: "not_directory",
  ELOOP: "invalid",
  EACCES: "permission_denied",
  EPERM: "permission_denied",
  EEXIST: "exists",
  EXDEV: "cross_device",
  ENAMETOOLONG: "invalid",
};

function codeOf(error) {
  return CODE_BY_ERRNO[error?.code] ?? "io";
}

function components(path) {
  if (!Array.isArray(path) || path.length === 0) fail("invalid", "path is not a list");
  for (const name of path) {
    if (typeof name !== "string" || name === "" || name === "." || name === "..") fail("invalid", "bad path component");
    if (name.includes("/") || name.includes("\\") || name.includes("\0")) fail("invalid", "bad path component");
  }
  return path;
}

async function openAt(dirFd, name, flags) {
  try {
    return await open(procFd(dirFd, name), flags);
  } catch (error) {
    throw new Failure(codeOf(error), name + ": " + error.message);
  }
}

async function readMarker(rootFd) {
  let dir;
  try {
    dir = await openAt(rootFd, ".hns", DIR_FLAGS);
  } catch (error) {
    if (error instanceof Failure && error.code === "not_found") return undefined;
    throw error;
  }
  try {
    let file;
    try {
      file = await openAt(dir.fd, "root.json", FILE_FLAGS);
    } catch (error) {
      if (error instanceof Failure && error.code === "not_found") return undefined;
      throw error;
    }
    try {
      return JSON.parse(await file.readFile("utf8")).id;
    } finally {
      await file.close();
    }
  } finally {
    await dir.close();
  }
}

/** The root as a directory fd, after checking it is still the one we opened. */
async function openRoot(args) {
  let root;
  try {
    root = await open(args.root, DIR_FLAGS);
  } catch (error) {
    const code = codeOf(error) === "not_found" ? "root_missing" : "root_replaced";
    throw new Failure(code, String(error?.message));
  }
  try {
    const stat = await root.stat();
    if (typeof args.dev === "number" && (stat.dev !== args.dev || stat.ino !== args.ino)) {
      fail("root_replaced", "root is a different directory");
    }
    const marker = await readMarker(root.fd);
    if (marker !== args.id) fail("root_replaced", "root marker does not match");
    return root;
  } catch (error) {
    await root.close();
    throw error;
  }
}

/** Directory handles for every component, the last one being the target's parent. */
async function openParentChain(root, names) {
  let parent = null;
  let fd = root.fd;
  try {
    for (const name of names) {
      const next = await openAt(fd, name, DIR_FLAGS);
      if (parent !== null) await parent.close();
      parent = next;
      fd = next.fd;
    }
    return parent;
  } catch (error) {
    if (parent !== null) await parent.close();
    throw error;
  }
}

async function openTarget(root, parent, name) {
  const fd = parent === null ? root.fd : parent.fd;
  try {
    return await open(procFd(fd, name), FILE_FLAGS);
  } catch (error) {
    throw new Failure(codeOf(error), name + ": " + error.message);
  }
}

async function expectRegular(file) {
  const stat = await file.stat();
  if (stat.isDirectory()) fail("is_directory", "is a directory");
  if (!stat.isFile()) fail("invalid", "not a regular file");
  return stat;
}

async function hashFile(file) {
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
async function versionAt(root, parent, name) {
  let file;
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

async function opProbe(args) {
  const root = await openRoot(args);
  try {
    const stat = await root.stat();
    return { ok: true, dev: stat.dev, ino: stat.ino };
  } finally {
    await root.close();
  }
}

async function opHash(args) {
  const names = components(args.path);
  const root = await openRoot(args);
  try {
    const parent = await openParentChain(root, names.slice(0, -1));
    try {
      return { ok: true, version: await versionAt(root, parent, names[names.length - 1]) };
    } finally {
      if (parent !== null) await parent.close();
    }
  } finally {
    await root.close();
  }
}

async function opRead(args) {
  const names = components(args.path);
  const root = await openRoot(args);
  try {
    const parent = await openParentChain(root, names.slice(0, -1));
    let file;
    try {
      file = await openTarget(root, parent, names[names.length - 1]);
    } finally {
      if (parent !== null) await parent.close();
    }
    try {
      const stat = await expectRegular(file);
      if (stat.size > MAX_READ) fail("too_large", "file is larger than " + MAX_READ + " bytes");
      const buffer = Buffer.allocUnsafe(stat.size);
      let offset = 0;
      while (offset < stat.size) {
        const { bytesRead } = await file.read(buffer, offset, stat.size - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return { ok: true, base64: buffer.subarray(0, offset).toString("base64"), size: offset };
    } finally {
      await file.close();
    }
  } finally {
    await root.close();
  }
}

/**
 * Compare the target with expectedVersion and only then rename the temp file
 * over it. Both names resolve from fds, so the rename cannot land in a
 * directory reached through a swapped parent or a symbolic link.
 */
async function opCommit(args) {
  const names = components(args.path);
  if (typeof args.temp !== "string" || args.temp === "" || args.temp.includes("/")) fail("invalid", "bad temp name");
  const root = await openRoot(args);
  try {
    const parent = await openParentChain(root, names.slice(0, -1));
    const name = names[names.length - 1];
    try {
      const current = await versionAt(root, parent, name);
      if (current !== args.expectedVersion) return { ok: true, status: "conflict", currentVersion: current };
      const target = procFd(parent === null ? root.fd : parent.fd, name);
      try {
        await rename(procFd(root.fd, args.temp), target);
      } catch (error) {
        throw new Failure(codeOf(error), "rename: " + error.message);
      }
      return { ok: true, status: "applied" };
    } finally {
      if (parent !== null) await parent.close();
    }
  } finally {
    await root.close();
  }
}

const OPS = { probe: opProbe, hash: opHash, read: opRead, commit: opCommit };

async function main() {
  const [name, encoded] = process.argv.slice(2);
  const op = OPS[name];
  if (op === undefined) {
    process.stderr.write("rooted: unknown op " + name + "\n");
    process.exitCode = 2;
    return;
  }
  let result;
  try {
    result = await op(JSON.parse(encoded ?? "{}"));
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    result = { ok: false, code: error.code, message: error.message };
  }
  process.stdout.write(JSON.stringify(result));
}

await main();
