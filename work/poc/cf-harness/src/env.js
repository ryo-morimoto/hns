// ExecutionEnv over the signed HTTP connection to the machine agent.
// The built-in read/write/edit/bash tools use a subset of these methods; the rest
// return typed errors so a missing capability fails loudly. See README.
import { posix } from "node:path";
import { ExecutionError, FileError, err, ok } from "@earendil-works/pi-durable/env";

const decodeBase64 = (value) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const asFileError = (path, error) => {
  if (error instanceof FileError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = message.includes("not_found")
    ? "not_found"
    : message.includes("path_outside_root")
      ? "permission_denied"
      : message.includes("conflict")
        ? "invalid"
        : "unknown";
  return new FileError(code, message, path);
};

export function createRemoteEnv(call) {
  const cwd = "/";
  const id = "machine";

  const resolve = (path) => posix.normalize(path.startsWith("/") ? path : posix.join(cwd, path));

  const attempt = async (path, work) => {
    try {
      return await work();
    } catch (error) {
      return err(asFileError(path, error));
    }
  };

  const fileInfo = async (path) => {
    const info = await call("stat", { path });
    if (info.exists !== true) throw new FileError("not_found", "no such file", path);
    return {
      name: posix.basename(path),
      path,
      kind: info.kind ?? "file",
      size: info.size ?? 0,
      mtimeMs: info.mtimeMs ?? 0,
    };
  };

  return {
    id,
    cwd,
    async absolutePath(path) {
      return ok(resolve(path));
    },
    async joinPath(parts) {
      return ok(posix.join(...parts));
    },
    async canonicalPath(path) {
      return ok(resolve(path));
    },
    async readTextFile(path) {
      return await attempt(path, async () => {
        const result = await call("read", { path });
        return ok(new TextDecoder().decode(decodeBase64(result.base64)));
      });
    },
    async readBinaryFile(path) {
      return await attempt(path, async () => ok(decodeBase64((await call("read", { path })).base64)));
    },
    async readTextLines(path, options) {
      return await attempt(path, async () => {
        const result = await call("read", { path });
        const text = new TextDecoder().decode(decodeBase64(result.base64));
        const limit = options?.maxLines ?? Number.POSITIVE_INFINITY;
        return ok(text.length === 0 ? [] : text.split("\n").slice(0, limit));
      });
    },
    async openTextLineReader(path) {
      return await attempt(path, async () => {
        const result = await call("read", { path });
        const lines = new TextDecoder().decode(decodeBase64(result.base64)).split("\n");
        let index = 0;
        return ok({
          async readLine() {
            if (index >= lines.length) return ok(undefined);
            const text = lines[index];
            index += 1;
            return ok({ text, terminated: text !== "" || index < lines.length });
          },
          async close() {},
        });
      });
    },
    async openBinaryReader(path, _options) {
      return await attempt(path, async () => {
        const result = await call("read", { path });
        const bytes = decodeBase64(result.base64);
        const info = {
          name: posix.basename(path),
          path,
          kind: "file",
          size: bytes.byteLength,
          mtimeMs: 0,
        };
        return ok({
          async info() {
            return ok(info);
          },
          async read(offset, length) {
            return ok(bytes.slice(offset, offset + length));
          },
          async close() {},
        });
      });
    },
    async writeFile(path, content) {
      return await attempt(path, async () => {
        const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
        const text = typeof content === "string" ? content : new TextDecoder().decode(content);
        void bytes;
        await call("write", { path, content: text });
        return ok(undefined);
      });
    },
    async appendFile(path, content) {
      return await attempt(path, async () => {
        const text = typeof content === "string" ? content : new TextDecoder().decode(content);
        await call("append", { path, content: text });
        return ok(undefined);
      });
    },
    async truncateFile(path, size) {
      return await attempt(path, async () => {
        await call("truncate", { path, size });
        return ok(undefined);
      });
    },
    async flushFile() {
      return ok(undefined);
    },
    async renameFile(sourcePath, destinationPath) {
      return await attempt(sourcePath, async () => {
        await call("rename", { from: sourcePath, to: destinationPath });
        return ok(undefined);
      });
    },
    async fileInfo(path) {
      return await attempt(path, async () => ok(await fileInfo(path)));
    },
    async listDir(path) {
      return await attempt(path, async () => {
        const result = await call("list", { path });
        return ok(
          result.entries.map((entry) => ({
            name: entry.name,
            path: posix.join(resolve(path), entry.name),
            kind: entry.kind,
            size: entry.size ?? 0,
            mtimeMs: entry.mtimeMs ?? 0,
          })),
        );
      });
    },
    async openDirReader(path) {
      return err(new FileError("not_supported", "openDirReader is not implemented", path));
    },
    async watch() {
      return err(new FileError("not_supported", "watch is not implemented", ""));
    },
    async exists(path) {
      return await attempt(path, async () => {
        const info = await call("stat", { path });
        return ok(info.exists === true);
      });
    },
    async createDir(path, options) {
      return await attempt(path, async () => {
        await call("mkdir", { path, recursive: options?.recursive !== false });
        return ok(undefined);
      });
    },
    async remove(path, options) {
      return await attempt(path, async () => {
        await call("remove", { path, recursive: options?.recursive === true });
        return ok(undefined);
      });
    },
    async createTempDir() {
      return err(new FileError("not_supported", "createTempDir is not implemented"));
    },
    async createTempFile() {
      return err(new FileError("not_supported", "createTempFile is not implemented"));
    },
    async cleanup() {},
    async exec(command, options, context) {
      const text =
        typeof command === "string"
          ? command
          : command.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
      const timeoutMs = Math.min((options?.timeout ?? 30) * 1000, 3_600_000);
      try {
        const result = await call("bash", { command: text, timeoutMs });
        const onOutput = options?.onOutput;
        if (onOutput) {
          if (result.stdout) onOutput(result.stdout, context, { stream: "stdout" });
          if (result.stderr) onOutput(result.stderr, context, { stream: "stderr" });
        }
        if (result.truncated) {
          onOutput?.("\n[hns] output truncated\n", context, { stream: "stderr" });
        }
        return ok({ exitCode: result.code });
      } catch (error) {
        return err(new ExecutionError("shell_unavailable", String(error?.message ?? error)));
      }
    },
  };
}
