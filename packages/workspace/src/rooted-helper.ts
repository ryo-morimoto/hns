// A helper process that opens and renames from a directory fd, so swapping a
// parent directory cannot redirect the operation outside the root.
//
// ExecutionEnv's file API takes paths only, and rename(2) re-resolves every
// component; Linux gives openat semantics through /proc/self/fd. The workspace
// runs this file through exec(), one process per operation, and keeps the older
// path-based checks where that is not possible (docs/workspace.md). The fd walk
// itself lives in ./files.ts, shared with the machine agent's write op.
import { open, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  DIR_FLAGS,
  FILE_FLAGS,
  FileSystemFailure,
  attempt,
  expectRegular,
  fail,
  namesOf,
  openAt,
  openParentChain,
  openTarget,
  procFd,
  versionAt,
} from "./files.ts";
import { parseMarker, parseRequest } from "./protocol.ts";
import type { HelperReply, HelperRequest } from "./protocol.ts";

/** Largest file the read op returns; above it the op fails as `too_large`. */
const MAX_READ = 8 * 1024 * 1024;

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
    if (error instanceof FileSystemFailure && error.code === "not_found") return undefined;
    throw error;
  }
  try {
    let file: FileHandle;
    try {
      file = await openAt(dir.fd, "root.json", FILE_FLAGS);
    } catch (error) {
      if (error instanceof FileSystemFailure && error.code === "not_found") return undefined;
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
    throw new FileSystemFailure(
      missing ? "root_missing" : "root_replaced",
      "the root cannot be opened",
    );
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
 * @throws {FileSystemFailure} `too_large` above 8 MiB, so one read cannot
 * exhaust the pipe or the caller's memory.
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
      error instanceof FileSystemFailure
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
