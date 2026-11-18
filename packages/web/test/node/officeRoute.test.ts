import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AgentSession } from "@hns/agent/session";
import type { PDFDocumentLoadingTask } from "pdfjs-dist";
// The machine and Session object are the product's own fixtures: relative paths, because the web
// package does not depend on either package and its tests read their test support directly.
import { withAgent } from "../../../machine/test/support/machine.ts";
import type { AgentFixture, AgentPaths } from "../../../machine/test/support/machine.ts";
import { controlPlaneKeys } from "../../../machine/test/support/control-plane.ts";
import type { ControlPlaneKeyPair } from "../../../machine/test/support/control-plane.ts";
import { Session } from "../../../server/src/do/session.ts";
import type { SessionEnv, SessionState } from "../../../server/src/do/state.ts";
import { SESSION_NAME_HEADER } from "../../../server/src/edge/env.ts";
import { openSqliteState } from "../../../server/test/support/sqlite.ts";
import { URL_DOCUMENT_OPTIONS } from "../../src/office/viewer.ts";
import { fillPdfjsGlobals } from "../support/pdfjs.ts";

/**
 * The reader, over the real preview route of a real machine.
 *
 * @remarks
 * **Run it from the repository root**: `HNS_REQUIRE_OFFICE_PACK=1 npx vitest run --project web-node`.
 * The `web-node` project (`vitest.web-node.config.ts`) is the one that runs under `node`
 * conditions, which is what loads the Session object from this install layout. Without the
 * variable the file skips, and says so: the pack is a build a full `npm run check` does not make
 * for it.
 * Every boundary is the product: the Session object's SQLite rows and alarm work, the signed
 * `op: "office"` and `GET /artifact` exchange with a real machine, its office executor and
 * bubblewrap, and the pack `tools/office-pack/build.sh` builds. The object's own route
 * (`previewStream`) answers with the artifact's stream; this test installs a `fetch` that gives
 * the **real reader** those bytes by ranges, and reads a page out of them. What is proven is
 * that the bytes a `ready` row hands out are a PDF the reader opens, whose page count is the
 * row's and whose page 1 carries the source document's text.
 *
 * PDF.js's browser build has no worker under Node (there is no `Worker`) and refuses to run on
 * this thread, so documents are opened with PDF.js's own **legacy build**: the same reader,
 * compiled for fewer globals. The viewer passes the browser build the same options.
 *
 * The pack is built once into this file's own directory. Every other test that needs a pack
 * builds its own, and `build.sh` clears and recreates a shared scratch tree, so one build per
 * process is what keeps concurrent builds from corrupting each other.
 */
// From this file to the checkout's root: packages/web/test/node.
const root = fileURLToPath(new URL("../../../..", import.meta.url));
const buildScript = join(root, "tools/office-pack/build.sh");
const packCache = process.env["IBIS_OFFICE_CACHE_DIR"] ?? join(root, ".cache/office-pack");
const fixture = join(root, "tools/office-pack/test/fixtures/ja.docx");
const requirePack = process.env["HNS_REQUIRE_OFFICE_PACK"] === "1";

/** The reason this host cannot build the pack, or undefined when it can (as 0236 names it). */
function missingPrerequisite(): string | undefined {
  for (const name of ["curl", "sha256sum", "unzip", "tar", "node"]) {
    if (spawnSync("sh", ["-c", "command -v " + name]).status !== 0) return name + " is not on PATH";
  }
  if (spawnSync("bwrap", ["--version"]).status !== 0) return "bwrap is not on PATH";
  for (const store of ["mesa", "vulkan-loader"]) {
    const found = spawnSync("sh", ["-c", "compgen -G '/nix/store/*-" + store + "-*' | head -n 1"], {
      encoding: "utf8",
    });
    if ((found.stdout ?? "").trim() === "") return "no " + store + " in /nix/store";
  }
  return undefined;
}

/**
 * Why this file does not run here, or undefined when it does.
 *
 * @remarks
 * The pack is a build (bubblewrap, Mesa, the ibisOffice release) that a full `npm run check`
 * cannot be asked to do for one web test: the file runs where a host can build the pack **and**
 * `HNS_REQUIRE_OFFICE_PACK=1` says to. Every other test that needs a pack in this repository
 * already decides that way.
 */
const skipReason =
  requirePack && missingPrerequisite() === undefined
    ? undefined
    : requirePack
      ? "the host cannot build the pack: " + (missingPrerequisite() ?? "")
      : "set HNS_REQUIRE_OFFICE_PACK=1 to run this file (it builds the office pack)";

let pack = "";
const cacheHomes: string[] = [];

beforeAll(async () => {
  if (skipReason !== undefined) return;
  const work = await realpath(await mkdtemp(join(tmpdir(), "hns-office-route-it-")));
  const built = join(work, "pack");
  execFileSync(buildScript, [], {
    env: { ...process.env, IBIS_OFFICE_PACK_DIR: built, IBIS_OFFICE_CACHE_DIR: packCache },
    stdio: "pipe",
  });
  // The pack lives beside the runs' directory tree (0236 measured why): a temporary directory a
  // second tmpfs is mounted over inside the sandbox makes the loader resolve the pack differently.
  const cacheHome = join(root, ".cache");
  await mkdir(cacheHome, { recursive: true });
  const beside = await realpath(await mkdtemp(join(cacheHome, "office-pack-route-it-")));
  pack = join(beside, "pack");
  execFileSync("cp", ["-a", built + "/.", pack]);
  await rm(built, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
  cacheHomes.push(beside);
}, 300_000);

afterAll(async () => {
  for (const path of cacheHomes) {
    if (path !== "") await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** The 32-byte Ed25519 seed `HNS_CONTROL_PLANE_KEY` holds, base64url (never a real key). */
const SEED = Buffer.from(new Uint8Array(32).fill(23)).toString("base64url");

/** The key pair whose private half is {@link SEED}. */
function keyPairOfSeed(): ControlPlaneKeyPair {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const privateKey = createPrivateKey({
    key: Buffer.concat([prefix, Buffer.from(SEED, "base64url")]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return { privateKey, publicKey: new Uint8Array(publicKey.subarray(12)) };
}

/** The workspace the object serves: its own name, which is the project id (D080). */
const WORKSPACE = "project-1";
/** The file the machine previews, relative to the machine ROOT. */
const FILE = "proposal.docx";

/**
 * A conversation runtime that never runs a turn.
 *
 * @returns The agent session contract, answering nothing: the office path opens no conversation.
 */
function inertSession(): AgentSession {
  return {
    closed: new Promise(() => undefined),
    createConversation: async () => {
      throw new Error("unused");
    },
    listConversations: async () => [],
    getConversation: async () => undefined,
    send: async () => {
      throw new Error("unused");
    },
    transcript: async () => [],
    watchConversation: async () => {
      throw new Error("unused");
    },
    abort: async () => false,
    pendingIndex: async () => ({ entries: [], remaining: 0, legacy: 0 }),
    markIndexed: async () => undefined,
    indexRows: async () => [],
    wake: () => ({ active: false }),
    resume: () => undefined,
    close: async () => undefined,
  };
}

/** The document the route's bytes make, with PDF.js's own legacy build. */
async function openWithReader(
  bytes: Uint8Array,
): Promise<{ task: PDFDocumentLoadingTask; pages: number }> {
  fillPdfjsGlobals();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes, ...URL_DOCUMENT_OPTIONS });
  const document = await task.promise;
  return { task, pages: document.numPages };
}

describe.skipIf(skipReason !== undefined)(
  "the preview over a real machine (" + (skipReason ?? "pack built") + ")",
  () => {
    test("a ready row's route hands the reader a PDF whose pages are the row's", async () => {
      await withAgent(
        async ({ root: machineRoot }: AgentPaths) => {
          await writeFile(join(machineRoot, FILE), await readFile(fixture));
        },
        async (agent: AgentFixture) => {
          const opened = openSqliteState();
          let alarm: number | null = null;
          const state: SessionState = {
            id: { name: WORKSPACE },
            storage: {
              ...opened.state.storage,
              getAlarm: async () => alarm,
              setAlarm: async (at: number) => {
                alarm = at;
              },
              deleteAlarm: async () => {
                alarm = null;
              },
            },
            blockConcurrencyWhile: opened.state.blockConcurrencyWhile,
            abort: () => undefined,
          };
          const env: SessionEnv = {
            HNS_ENV: "dev",
            HNS_AGENT_URL: agent.origin,
            HNS_MACHINE_ID: agent.machineId,
            HNS_CONTROL_PLANE_KEY: SEED,
          };
          const session = new Session(state, env, async () => inertSession());
          /** One office RPC: the object's route, addressed to it by name. */
          const rpc = async (path: string, init: RequestInit = {}): Promise<Response> =>
            await session.fetch(
              new Request("https://session.internal" + path, {
                ...init,
                headers: { "content-type": "application/json", [SESSION_NAME_HEADER]: WORKSPACE },
              }),
            );
          try {
            await session.ready();
            const source = await readFile(fixture);
            const version = "sha256:" + createHash("sha256").update(source).digest("hex");
            // The request writes a queued row and arms the alarm; the alarm runs the real pack.
            const requested = await rpc("/rpc/office/request?workspaceId=" + WORKSPACE, {
              method: "POST",
              body: JSON.stringify({ path: FILE, version }),
            });
            expect(requested.status).toBe(200);
            await session.alarm();
            const read = await rpc(
              "/rpc/office/preview?workspaceId=" +
                WORKSPACE +
                "&path=" +
                encodeURIComponent(FILE) +
                "&v=" +
                encodeURIComponent(version),
              { method: "GET" },
            );
            expect(read.status).toBe(200);
            // The object's answer, parsed at this boundary like any other external value.
            const row = v.parse(
              v.object({
                status: v.string(),
                url: v.nullable(v.string()),
                pages: v.nullable(v.number()),
                bytes: v.nullable(v.number()),
                engine: v.nullable(v.string()),
              }),
              await read.json(),
            );
            expect(row).toMatchObject({ status: "ready", engine: "0.8.7" });
            if (row.url === null || row.url === undefined) {
              throw new Error("a ready row names its route");
            }
            // The row's own route is the contract's, read back the way the object reads it.
            const query = new URL(row.url, "https://session.internal");
            expect(query.pathname).toBe("/api/office/preview");
            const target = await session.previewStream(new Request(query));
            expect(target.status).toBe(200);
            expect(target.headers.get("content-type")).toBe("application/pdf");
            // The reader opens exactly what the route serves.
            const openedDoc = await openWithReader(
              new Uint8Array(await target.clone().arrayBuffer()),
            );
            try {
              expect(openedDoc.pages).toBe(row.pages);
              const document = await openedDoc.task.promise;
              const page = await document.getPage(1);
              const content = await page.getTextContent();
              const text = content.items.map((item) => ("str" in item ? item.str : "")).join("");
              // The pack's own fixture: its Japanese text and its page number, read from the
              // route's bytes by the reader — what the source document says is what is shown.
              expect(text).toContain("日本語の本文です");
              expect(text).toContain("Page 1");
            } finally {
              await openedDoc.task.destroy();
            }
          } finally {
            opened.close();
          }
        },
        // The real pack the build made in beforeAll, and a fresh cache per run.
        { office: { packRoot: pack }, controlPlane: controlPlaneKeys([keyPairOfSeed()]) },
      );
    }, 180_000);
  },
);
