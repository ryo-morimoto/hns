import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import * as v from "valibot";
import type { AgentSession } from "@hns/agent/session";
import { ProjectIdSchema, type JsonValue } from "@hns/core";
import { controlPlaneKeys } from "../../../machine/test/support/control-plane.ts";
import type { ControlPlaneKeyPair } from "../../../machine/test/support/control-plane.ts";
import { withAgent } from "../../../machine/test/support/machine.ts";
import type { AgentFixture } from "../../../machine/test/support/machine.ts";
import { Session } from "../../src/do/session.ts";
import type { SessionEnv, SessionState } from "../../src/do/state.ts";
import { SESSION_NAME_HEADER } from "../../src/edge/env.ts";
import { createGraphQLFace } from "../../src/graphql/handler.ts";
import { officePortOver } from "../../src/graphql/office-port.ts";
import { envWith } from "../support/edge.ts";
import { openSqliteState } from "../support/sqlite.ts";
/**
 * The office face's real path (0237): the Session object calls a **real machine** over its signed
 * RPC, the machine runs the **real pack**, and the object serves the preview through its own
 * route.
 *
 * @remarks
 * Every boundary on this path is the product: the object's office rows and alarm work,
 * `createSignedMachineFiles` signing `op: "office"` and the signed `GET /artifact` target, the
 * machine's own verifier, its office executor, and bubblewrap. Only the clock and the storage are
 * the test's. **This is the first test to take server → machine over the signed RPC**: 0236 proved
 * the machine's routes with a test client, and this proves the Worker's client signs what the
 * machine verifies.
 */
const root = fileURLToPath(new URL("../../../..", import.meta.url));
const buildScript = join(root, "tools/office-pack/build.sh");
const packCache = process.env.IBIS_OFFICE_CACHE_DIR ?? join(root, ".cache/office-pack");
const fixture = join(root, "tools/office-pack/test/fixtures/ja.docx");
const requirePack = process.env.HNS_REQUIRE_OFFICE_PACK === "1";

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

const skipReason = missingPrerequisite();
if (skipReason !== undefined && requirePack) {
  throw new Error("HNS_REQUIRE_OFFICE_PACK=1 but this host cannot build the pack: " + skipReason);
}

let work = "";
let pack = "";
const packs: string[] = [];

beforeAll(async () => {
  if (skipReason !== undefined) return;
  work = await realpath(await mkdtemp(join(tmpdir(), "hns-server-office-it-")));
  const built = join(work, "pack");
  execFileSync(buildScript, [], {
    env: { ...process.env, IBIS_OFFICE_PACK_DIR: built, IBIS_OFFICE_CACHE_DIR: packCache },
    stdio: "pipe",
  });
  // The pack lives beside the runs' directory tree (0236 measured why): a temporary directory a
  // second tmpfs is mounted over inside the sandbox makes the loader resolve the pack differently.
  const cacheHome = join(root, ".cache");
  await mkdir(cacheHome, { recursive: true });
  const beside = await realpath(await mkdtemp(join(cacheHome, "office-pack-server-it-")));
  const moved = join(beside, "pack");
  execFileSync("cp", ["-a", built + "/.", moved]);
  await rm(built, { recursive: true, force: true });
  pack = moved;
  packs.push(beside);
});

afterAll(async () => {
  for (const path of [work, ...packs]) {
    if (path !== "") await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** The 32-byte Ed25519 seed `HNS_CONTROL_PLANE_KEY` holds, base64url (never a real key). */
const SEED = Buffer.from(new Uint8Array(32).fill(23)).toString("base64url");

/**
 * The control-plane key pair whose private half is {@link SEED}.
 *
 * @returns The key a machine enrolls, and the signing seed the object is given.
 *
 * @remarks
 * The seed is a PKCS#8 Ed25519 private key with the seed as its last 32 bytes; importing it gives
 * the private key whose public half is what an enrollment carries.
 */
function keyPairOfSeed(): ControlPlaneKeyPair {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const seed = Buffer.from(SEED, "base64url");
  const privateKey = createPrivateKey({
    key: Buffer.concat([prefix, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return { privateKey, publicKey: new Uint8Array(publicKey.subarray(12)) };
}

/** The workspace the object serves: its own name, which is the project id (D080). */
const WORKSPACE = "project-1";
/** A second file with the first's bytes: a different (path, version) for the GraphQL leg. */
const SECOND = "copy/proposal.docx";

/**
 * The project row the office port's workspace lookup answers with.
 *
 * @returns The project, with its root at the machine's ROOT (the port only needs the id here).
 */
function projectRow() {
  return {
    id: v.parse(ProjectIdSchema, WORKSPACE),
    name: WORKSPACE,
    workspace_root: "",
    agent_cwd: "",
    egress: "inherit" as const,
    created_at: "2026-11-19T00:00:00.000Z",
  };
}
/** The file the object previews, relative to ROOT. */
const FILE = "proposal.docx";

/**
 * A conversation runtime that never runs a turn.
 *
 * @returns The agent session contract, answering nothing and closing at once.
 *
 * @remarks
 * The office path does not open a conversation; the object builds its runtime at open, so this is
 * the one piece of the product this test stands in for.
 */
function inertSession(): AgentSession {
  return {
    // A session that is already closed: nothing waits on it, and a close would have no end.
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

/**
 * One Session object over a real agent, driven only by its public surface.
 *
 * @param agent - The running machine.
 * @returns The object, its SQLite (for the rows), and what its office route answers.
 */
async function openObject(agent: AgentFixture) {
  const opened = openSqliteState();
  let alarm: number | null = null;
  const storage: DurableObjectSqliteStorage & {
    getAlarm(): Promise<number | null>;
    setAlarm(at: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  } = {
    ...opened.state.storage,
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
  const state: SessionState = {
    id: { name: WORKSPACE },
    storage,
    blockConcurrencyWhile: opened.state.blockConcurrencyWhile,
    abort: () => undefined,
  };
  // The object's bindings are the deployment's three (the granted path's set), so the object opens
  // the way production does; the conversation runtime is the one seam a test supplies, because
  // this test never opens a conversation (the office path does not touch it).
  const env: SessionEnv = {
    HNS_ENV: "dev",
    HNS_AGENT_URL: agent.origin,
    HNS_MACHINE_ID: agent.machineId,
    HNS_CONTROL_PLANE_KEY: SEED,
  };
  const session = new Session(state, env, async () => inertSession());
  /** One office RPC, as the GraphQL face's port calls it: a method, a route, and its own query. */
  const rpc = async (path: string, init: RequestInit = {}): Promise<Response> =>
    await session.fetch(
      new Request("https://session.internal" + path, {
        ...init,
        // SAFETY: the callers pass a plain header record or nothing; the object reads it as one.
        headers: { ...(init.headers as Record<string, string>), [SESSION_NAME_HEADER]: WORKSPACE },
      }),
    );
  // The object opens under blockConcurrencyWhile; a test object is built synchronously, so the
  // first call waits for the open the way a route does.
  await session.ready();
  return {
    session,
    rpc,
    opened,
    /** One preview read of the fixture at its current version: the object's own answer. */
    preview: async (version: string): Promise<Readonly<Record<string, JsonValue>>> => {
      const query = new URLSearchParams({ workspaceId: WORKSPACE, path: FILE, v: version });
      const answer = await rpc("/rpc/office/preview?" + query.toString(), { method: "GET" });
      return await answer.json();
    },
    /** One preview request for the fixture at its current version: the object's own answer. */
    request: async (version: string): Promise<Readonly<Record<string, JsonValue>>> => {
      const query = new URLSearchParams({ workspaceId: WORKSPACE });
      const answer = await rpc("/rpc/office/request?" + query.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: FILE, version }),
      });
      return await answer.json();
    },
    /** The alarm the object has armed, in epoch milliseconds. */
    alarmAt: () => alarm,
  };
}

describe.skipIf(skipReason !== undefined)(
  "the office face over a real machine (" + (skipReason ?? "pack built") + ")",
  () => {
    test("server → machine: request queues, the alarm runs the real pack, and the route streams the preview", async () => {
      await withAgent(
        async ({ root }) => {
          // The file the machine previews: the pack's own Japanese fixture, at the top of ROOT.
          await writeFile(join(root, FILE), await readFile(fixture));
        },
        async (agent) => {
          const object = await openObject(agent);
          try {
            const bytes = await readFile(fixture);
            const version = "sha256:" + createHash("sha256").update(bytes).digest("hex");

            // The mutation's half: the object asks the machine's engine probe over the signed RPC,
            // writes a queued row, and arms the alarm. No job runs here.
            const queued = v.parse(
              v.object({ __typename: v.literal("DocumentPreview"), status: v.literal("queued") }),
              await object.request(version),
            );
            expect(queued.status).toBe("queued");
            const armed = object.alarmAt();
            expect(armed).not.toBeNull();

            // The alarm's half: the object calls op:"office" on the machine, which runs the real
            // pack in bubblewrap, and writes what came back to its row.
            await object.session.alarm();
            const ready = v.parse(
              v.object({
                __typename: v.literal("DocumentPreview"),
                status: v.literal("ready"),
                url: v.string(),
                pages: v.pipe(v.number(), v.minValue(1)),
                bytes: v.pipe(v.number(), v.minValue(1)),
                engine: v.string(),
              }),
              await object.preview(version),
            );
            expect(ready.engine).toBe("0.8.7");

            // The route: authorized by the object, served from the machine's GET /artifact over the
            // signed target, streamed with the artifact's own length.
            const streamed = await object.session.previewStream(
              new Request("https://session.internal" + ready.url),
            );
            expect(streamed.status).toBe(200);
            expect(streamed.headers.get("content-type")).toBe("application/pdf");
            expect(streamed.headers.get("content-length")).toBe(String(ready.bytes));
            const served = new Uint8Array(await streamed.arrayBuffer());
            expect(served.byteLength).toBe(ready.bytes);
            expect(served.subarray(0, 5)).toStrictEqual(new TextEncoder().encode("%PDF-"));

            // The GraphQL leg (B1): the face's own port, addressed to the object by name through
            // the SESSION binding, writes a row and the alarm runs it on the real machine. Every
            // boundary is the product: createGraphQLFace -> officePortOver -> the object's
            // /rpc/office/* -> the alarm -> the machine's signed op:"office".
            const binding = {
              idFromName: (name: string) => ({ toString: () => name }),
              get: () => ({ fetch: (forwarded: Request) => object.session.fetch(forwarded) }),
            };
            const graphql = createGraphQLFace({
              // The workspace lookup is D1 in production; this test names its one project.
              office: await officePortOver({
                // The Workspace object's read route answers the file's version (`/rpc/read`); this
                // test answers that one query for the root the project names.
                // SAFETY: a test namespace with exactly the two members a binding is used through
                // (idFromName and get), where the binding type carries the whole object surface.
                env: envWith({
                  session: binding as never,
                  // SAFETY: the Workspace object's one read route answers the version; this stub is
                  // reached for exactly that call in this test.
                  workspace: {
                    idFromName: (name: string) => ({ toString: () => name }),
                    get: () => ({
                      fetch: async () =>
                        new Response(JSON.stringify({ ok: true, version }), {
                          headers: { "content-type": "application/json" },
                        }),
                    }),
                  } as never,
                }),
                requestId: "office-graphql",
                signal: new AbortController().signal,
                project: async (id) => (id === WORKSPACE ? projectRow() : undefined),
              }),
            });
            const ask = async (query: string) =>
              await graphql({
                request: new Request("https://hns.test/graphql", { method: "POST" }),
                // SAFETY: the same two-member namespace, for the port and the face (above).
                env: envWith({ session: binding as never }),
                session: { subject: "owner", expiresAt: Date.now() + 60_000 },
                requestId: "office-graphql",
                signal: new AbortController().signal,
                body: JSON.stringify({ query, variables: { path: SECOND } }),
              });
            // A second file with the same bytes is a different (path, version): its own row,
            // its own job, and the alarm must run it through the GraphQL face.
            await mkdir(join(agent.root, "copy"), { recursive: true });
            await writeFile(join(agent.root, SECOND), await readFile(fixture));
            const requested = v.parse(
              v.object({
                data: v.object({
                  requestDocumentPreview: v.object({
                    __typename: v.literal("DocumentPreview"),
                    status: v.literal("QUEUED"),
                  }),
                }),
              }),
              await (
                await ask(
                  `mutation Request($path: String!) { requestDocumentPreview(path: $path, workspaceId: "${WORKSPACE}") { __typename ... on DocumentPreview { status } ... on OfficeFailure { code } } }`,
                )
              ).json(),
            );
            expect(requested.data.requestDocumentPreview.status).toBe("QUEUED");
            await object.session.alarm();
            const graphqlReady = v.parse(
              v.object({
                data: v.object({
                  documentPreview: v.object({
                    __typename: v.literal("DocumentPreview"),
                    status: v.literal("READY"),
                    url: v.string(),
                  }),
                }),
              }),
              await (
                await ask(
                  `query Read($path: String!) { documentPreview(path: $path, workspaceId: "${WORKSPACE}") { __typename ... on DocumentPreview { status url } ... on OfficeFailure { code } } }`,
                )
              ).json(),
            );
            expect(graphqlReady.data.documentPreview.status).toBe("READY");
          } finally {
            object.opened.close();
          }
        },
        {
          // The real pack the build made in beforeAll, and a fresh cache per run.
          office: { packRoot: pack },
          controlPlane: controlPlaneKeys([keyPairOfSeed()]),
          // The object's open needs no control database in development, but the tool-path check
          // wants all three bindings or none; this object is given them by the env above.
        },
      );
    }, 180_000);
  },
);
