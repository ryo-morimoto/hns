import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as v from "valibot";
import {
  CF_DEV_WORK_DIR,
  isCfDevInstalled,
  startCfDev,
  type CfDev,
} from "../../../../tools/test/cf-dev.ts";
import { ensureDist } from "../../../../tools/test/ensure-dist.ts";

/**
 * The pack reader inside workerd.
 *
 * @remarks
 * `openPack` uses `node:zlib`, which workerd serves under `nodejs_compat`. A node-only test cannot
 * show that the compatibility layer implements `inflateSync` with the `info` option, so this suite
 * runs the reader in the Worker runtime the product ships on. The pack arrives as bytes and the
 * objects come back as JSON, because a pack is binary and the point is the bytes, not an encoding.
 */
const TIMEOUT_MS = 300_000;
const READY_TIMEOUT_MS = 60_000;

const CONFIG = [
  'import { defineConfig } from "cf/config";',
  "",
  "export default defineConfig({",
  "  worker: {",
  '    name: "hns-pack-test",',
  '    compatibilityDate: "2026-10-30",',
  '    compatibilityFlags: ["nodejs_compat"],',
  '    entrypoint: "worker.ts",',
  "  },",
  "});",
  "",
].join("\n");

const WORKER = [
  'import { openPack } from "@hns/workspace/pack";',
  "",
  "export default {",
  "  async fetch(request) {",
  "    const path = new URL(request.url).pathname;",
  '    if (path === "/health") return new Response("ok");',
  '    if (path === "/open" && request.method === "POST") {',
  "      const bytes = new Uint8Array(await request.arrayBuffer());",
  "      try {",
  "        const pack = await openPack(bytes);",
  "        const objects = pack.ids.map((id) => {",
  "          const object = pack.getObject(id);",
  "          return {",
  "            id,",
  "            type: object?.type ?? null,",
  "            bytes: object === null ? [] : Array.from(object.content),",
  "          };",
  "        });",
  "        return Response.json({ ok: true, objects });",
  "      } catch (cause) {",
  "        return Response.json({ ok: false, error: String(cause) });",
  "      }",
  "    }",
  '    return new Response("not found", { status: 404 });',
  "  },",
  "};",
  "",
].join("\n");

const Opened = v.object({
  ok: v.literal(true),
  objects: v.array(
    v.object({ id: v.string(), type: v.nullable(v.string()), bytes: v.array(v.number()) }),
  ),
});

let running: CfDev | undefined;

async function writeProject(): Promise<string> {
  await mkdir(CF_DEV_WORK_DIR, { recursive: true });
  const dir = await mkdtemp(join(CF_DEV_WORK_DIR, "pack-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "hns-pack-test",
      private: true,
      type: "module",
      devDependencies: { wrangler: "4.156.0" },
    }),
  );
  await symlink(join("..", "..", "node_modules"), join(dir, "node_modules"));
  await writeFile(join(dir, "cloudflare.config.ts"), CONFIG);
  await writeFile(join(dir, "worker.ts"), WORKER);
  return dir;
}

beforeAll(async () => {
  if (!isCfDevInstalled()) return;
  ensureDist(["@hns/workspace"]);
  const project = await writeProject();
  running = await startCfDev({ cwd: project, readyTimeoutMs: READY_TIMEOUT_MS });
}, TIMEOUT_MS);

afterAll(async () => {
  await running?.stop();
  running = undefined;
});

/** Build a v2 pack of `(type, content)` objects, the way a checkpoint writes one. */
const packOf = async (
  objects: readonly { readonly type: "blob" | "tree" | "commit"; readonly content: Uint8Array }[],
): Promise<Uint8Array> => {
  const { deflateSync } = await import("node:zlib");
  const { gitObjectId } = await import("@hns/workspace/objects");
  const ids: string[] = [];
  for (const object of objects) ids.push(await gitObjectId(object));
  const typeNumber = { commit: 1, tree: 2, blob: 3 } satisfies Record<string, number>;
  const headerByte = (size: number, type: number): number[] => {
    const groups: number[] = [];
    let rest = Math.floor(size / 16);
    while (rest > 0) {
      groups.push(rest % 128);
      rest = Math.floor(rest / 128);
    }
    const bytes = [(size % 16) | (type << 4) | (groups.length > 0 ? 0x80 : 0)];
    groups.forEach((group, index) =>
      bytes.push(index === groups.length - 1 ? group : group | 0x80),
    );
    return bytes;
  };
  const encoded: number[] = [0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, objects.length];
  for (const object of objects) {
    encoded.push(...headerByte(object.content.length, typeNumber[object.type] ?? 0));
    for (const byte of deflateSync(object.content)) encoded.push(byte);
  }
  const body = Uint8Array.from(encoded);
  const trailer = new Uint8Array(await crypto.subtle.digest("SHA-1", new Uint8Array(body)));
  const out = new Uint8Array(body.length + trailer.length);
  out.set(body, 0);
  out.set(trailer, body.length);
  return out;
};

// Catches: a reader that works under node and fails under workerd — a node:zlib call the
// compatibility layer does not implement, or a global the Worker does not have — which would only
// surface in production.
test(
  "reads a pack inside workerd with node:zlib",
  async () => {
    if (running === undefined) {
      expect(isCfDevInstalled()).toBe(false);
      return;
    }
    const content = new TextEncoder().encode("hello from the worker\n");
    const pack = await packOf([{ type: "blob", content }]);
    const response = await fetch(running.url + "/open", {
      method: "POST",
      body: new Uint8Array(pack),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const opened = v.parse(Opened, JSON.parse(text));
    expect(opened.objects).toHaveLength(1);
    const [object] = opened.objects;
    expect(object?.type).toBe("blob");
    expect(new TextDecoder().decode(Uint8Array.from(object?.bytes ?? []))).toBe(
      "hello from the worker\n",
    );
  },
  TIMEOUT_MS,
);

// Catches: a corrupt pack read as valid under workerd when it is refused under node, which would
// make a damaged checkpoint look reviewable in production.
test(
  "refuses a corrupt pack inside workerd, as node does",
  async () => {
    if (running === undefined) {
      expect(isCfDevInstalled()).toBe(false);
      return;
    }
    const pack = await packOf([{ type: "blob", content: new TextEncoder().encode("x\n") }]);
    const corrupt = new Uint8Array(pack);
    // Flip a byte inside the deflate stream, not the trailer.
    const at = 14;
    corrupt[at] = (corrupt[at] ?? 0) ^ 0xff;
    const response = await fetch(running.url + "/open", {
      method: "POST",
      body: new Uint8Array(corrupt),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const answer = v.parse(v.object({ ok: v.boolean() }), JSON.parse(text));
    expect(answer.ok).toBe(false);
  },
  TIMEOUT_MS,
);
