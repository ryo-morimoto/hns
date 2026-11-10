// Machine-side agent for the Cloudflare harness PoC.
// One HTTP endpoint, signed by the caller (HMAC-SHA256), confined to HNS_ROOT.
// Not product code: no bwrap, no journal, no lease. See README.
import { createHmac, timingSafeEqual, randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { appendFile, mkdir, open, readFile, readdir, realpath, rename, rm, stat, truncate } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.env.HNS_ROOT ?? process.cwd());
const SECRET = process.env.HNS_AGENT_SECRET ?? "";
const PORT = Number(process.env.HNS_AGENT_PORT ?? 8788);
const CLOCK_SKEW_MS = 60_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;

if (SECRET.length < 16) {
  console.error("HNS_AGENT_SECRET must be set (>= 16 chars)");
  process.exit(2);
}

const seenNonces = new Map();

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const ms = (started) => Math.round((performance.now() - started) * 100) / 100;

/** Resolve inside ROOT. A leading "/" is ROOT-relative; ".." may not escape. */
async function contained(relative) {
  if (typeof relative !== "string" || relative.length === 0) {
    throw new RpcError("invalid_request", "path is required");
  }
  const stripped = relative.replace(/^\/+/, "");
  const candidate = path.resolve(ROOT, stripped);
  const rel = path.relative(ROOT, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new RpcError("path_outside_root", relative);
  const parent = await realpath(path.dirname(candidate)).catch(() => {
    throw new RpcError("not_found", path.dirname(relative));
  });
  const parentRel = path.relative(ROOT, parent);
  if (parentRel.startsWith("..") || path.isAbsolute(parentRel)) {
    throw new RpcError("path_outside_root", relative);
  }
  return path.join(parent, path.basename(candidate));
}

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fsyncDirectory(dir) {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readBytes(relative) {
  const file = await contained(relative);
  try {
    const bytes = await readFile(file);
    return { bytes, file };
  } catch (error) {
    if (error.code === "ENOENT") throw new RpcError("not_found", relative);
    throw new RpcError("read_failed", String(error.message));
  }
}

async function writeAtomically(file, bytes) {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.hns-tmp-${randomUUID()}`);
  const handle = await open(temp, "wx", 0o644);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
  await fsyncDirectory(dir);
}

async function runBash(command, timeoutMs) {
  const started = performance.now();
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: ROOT,
      detached: true,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: ROOT, LANG: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const take = (current, text) => {
      if (current.length + stderr.length + stdout.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        return current;
      }
      return current + text;
    };
    child.stdout.on("data", (chunk) => {
      const text = take(stdout, chunk.toString("utf8"));
      if (text !== stdout) stdout = text;
    });
    child.stderr.on("data", (chunk) => {
      const text = take(stderr, chunk.toString("utf8"));
      if (text !== stderr) stderr = text;
    });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeoutMs ?? 30_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new RpcError("exec_failed", String(error.message)));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, signal: signal ?? null, stdout, stderr, truncated, execMs: ms(started) });
    });
  });
}

const OPERATIONS = {
  async read(args) {
    const { bytes } = await readBytes(args.path);
    return {
      base64: bytes.toString("base64"),
      version: hash(bytes),
      size: bytes.byteLength,
    };
  },
  async stat(args) {
    let file;
    try {
      file = await contained(args.path);
    } catch (error) {
      if (error instanceof RpcError && error.code === "not_found") return { exists: false };
      throw error;
    }
    try {
      const info = await stat(file);
      if (!info.isFile()) {
        return { exists: true, kind: info.isDirectory() ? "directory" : "symlink", size: info.size, mtimeMs: info.mtimeMs };
      }
      const bytes = await readFile(file);
      return { exists: true, kind: "file", size: info.size, mtimeMs: info.mtimeMs, version: hash(bytes) };
    } catch (error) {
      if (error.code === "ENOENT") return { exists: false };
      throw new RpcError("stat_failed", String(error.message));
    }
  },
  async list(args) {
    const dir = await contained(args.path);
    const entries = await readdir(dir, { withFileTypes: true });
    return {
      entries: entries.map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
      })),
    };
  },
  async write(args) {
    const file = await contained(args.path);
    let current = "absent";
    try {
      current = hash(await readFile(file));
    } catch (error) {
      if (error.code !== "ENOENT") throw new RpcError("write_failed", String(error.message));
    }
    if (args.expectedVersion !== undefined && args.expectedVersion !== current) {
      throw new RpcError("conflict", `expected ${args.expectedVersion}, found ${current}`);
    }
    const bytes = Buffer.from(args.content ?? "", "utf8");
    await writeAtomically(file, bytes);
    return { version: hash(bytes), size: bytes.byteLength };
  },
  async append(args) {
    const file = await contained(args.path);
    const bytes = Buffer.from(args.content ?? "", "utf8");
    await appendFile(file, bytes);
    return { version: hash(await readFile(file)) };
  },
  async truncate(args) {
    const file = await contained(args.path);
    await truncate(file, args.size ?? 0);
    return { version: hash(await readFile(file)) };
  },
  async mkdir(args) {
    const dir = await contained(args.path);
    await mkdir(dir, { recursive: args.recursive !== false });
    return {};
  },
  async remove(args) {
    const target = await contained(args.path);
    await rm(target, { recursive: args.recursive === true, force: true });
    return {};
  },
  async rename(args) {
    const from = await contained(args.from);
    const to = await contained(args.to);
    await rename(from, to);
    return {};
  },
  async bash(args) {
    return await runBash(args.command, args.timeoutMs);
  },
  async health() {
    return { root: ROOT, pid: process.pid };
  },
};

function verify(headers, body) {
  const timestamp = Number(headers["x-hns-timestamp"]);
  const nonce = headers["x-hns-nonce"];
  const signature = headers["x-hns-signature"];
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > CLOCK_SKEW_MS) {
    throw new RpcError("stale_request", "timestamp outside window");
  }
  if (typeof nonce !== "string" || nonce.length < 8) throw new RpcError("invalid_request", "nonce");
  if (typeof signature !== "string") throw new RpcError("unauthorized", "signature missing");
  const expected = createHmac("sha256", SECRET).update(`${timestamp}.${nonce}.`).update(body).digest("hex");
  const given = Buffer.from(signature, "hex");
  const want = Buffer.from(expected, "hex");
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new RpcError("unauthorized", "signature mismatch");
  }
  if (seenNonces.has(nonce)) throw new RpcError("replayed", nonce);
  seenNonces.set(nonce, Date.now() + CLOCK_SKEW_MS);
  if (seenNonces.size > 10_000) {
    for (const [key, at] of seenNonces) if (at < Date.now()) seenNonces.delete(key);
  }
}

const DELAY_MS = Number(process.env.HNS_AGENT_DELAY_MS ?? 0);

const server = createServer(async (request, response) => {
  const started = performance.now();
  if (DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      response.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const send = (status, payload) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ ...payload, serverMs: ms(started) }));
  };
  try {
    verify(request.headers, body);
    const parsed = JSON.parse(body.toString("utf8") || "{}");
    const handler = OPERATIONS[parsed.op];
    if (handler === undefined) throw new RpcError("invalid_request", `unknown op ${parsed.op}`);
    const result = await handler(parsed.args ?? {});
    send(200, { ok: true, op: parsed.op, ...result });
  } catch (error) {
    if (error instanceof RpcError) {
      send(error.code === "unauthorized" ? 401 : 400, { ok: false, code: error.code, message: error.message });
      return;
    }
    send(500, { ok: false, code: "internal", message: String(error?.message ?? error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "listening", port: PORT, root: ROOT }));
});
