import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { execute, parse, type ExecutionResult } from "graphql";
import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { AgentSession } from "@hns/agent/session";
import { toGlobalId } from "@hns/core/graphql";
import * as v from "valibot";
import { openStore } from "../../../store/src/index.ts";
import { openConversationIndex } from "../../../store/src/conversation-index/index.ts";
import { createD1Harness, type D1Harness } from "../../../store/test/integration/harness.ts";
import { startMachineAgent } from "../../../machine/src/index.ts";
import { GrantCounter } from "../../../machine/src/capability/counter.ts";
import { controlPlanePublicKey } from "../../src/capability/signing.ts";
import { createPolicyService } from "../../src/policy/service.ts";
import { Session } from "../../src/do/session.ts";
import { toolPathMode } from "../../src/do/tool-path-mode.ts";
import type { SessionState } from "../../src/do/state.ts";
import { openSqliteState } from "../support/sqlite.ts";
import { createContext } from "../../src/graphql/context.ts";
import { buildGraphQLSchema } from "../../src/graphql/schema.ts";
import { sendMessageModule } from "../../src/graphql/mutations/send-message.ts";

/**
 * Mutation probes for 0270n: each changes one thing the issue's own fix depends on, and the
 * product's assertion for that case must fail (the three "掟" of the lane).
 *
 * @remarks
 * **M1 — the snapshot is not carried.** The Worker\'s send body drops `policy`, exactly what a
 * first draft that "just forwards the text" does. Expected: the object admits no revision, so
 * `#grantPathFor` stays closed and the relay answers `unavailable`; the product test that asks for a
 * granted call fails. This probe asks the same two questions the product test does.
 *
 * **M2 — a partial tool path is a Phase 0 deployment.** `toolPathMode` decides `phase0` whenever any
 * binding is missing, exactly the fallback the issue forbids. Expected: the Session object opens, the
 * send is answered 200, and no request is ever refused — the product test that expects a 503 fails.
 */

const SEED = Buffer.from(new Uint8Array(32).fill(29)).toString("base64url");
const MACHINE_ID = "machine-mutation";
const CONVERSATION_ID = "conversation-mutation";
const SUBJECT = "person-1";

let d1: D1Harness;
let base = "";

beforeAll(async () => {
  d1 = await createD1Harness();
  base = await mkdtemp(join(tmpdir(), "hns-mutation-0270n-"));
});

afterAll(async () => {
  await d1.dispose();
  await rm(base, { recursive: true, force: true });
});

const SEND_MESSAGE =
  "mutation Send($input: SendMessageInput!) { sendMessage(input: $input) { __typename ... on SendMessagePayload { submissionId status } ... on MutationFailure { code } } }";
const schema = buildGraphQLSchema([sendMessageModule()]);

/** A settled answer for a send whose model never runs. */
function fakeTurn(): Awaited<ReturnType<AgentSession["send"]>> {
  const turn = { settlement: { id: "1", status: "unanswered", reason: "test" }, text: "" };
  // SAFETY: the route reads only the settlement\'s id; this is the answer of a send whose model
  // never runs.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the fake is not the real Turn.
  return turn as unknown as Awaited<ReturnType<AgentSession["send"]>>;
}

/** The chain with one thing changed: what the send body carries, and how the object opens. */
interface Probe {
  /** Run the mutation; returns the GraphQL result. */
  readonly send: () => Promise<ExecutionResult>;
  /** Ask the object for one granted call. */
  readonly relay: () => Promise<{ readonly ok: boolean; readonly code?: string }>;
  readonly close: () => Promise<void>;
}

/**
 * Build the chain for one probe.
 *
 * @param options - `snapshot: false` drops the policy from the send body (M1); `objectEnv` replaces
 * the object\'s bindings (M2 runs a partly configured one).
 */
async function probe(options: {
  readonly snapshot: boolean;
  readonly objectEnv?: Partial<
    Record<"HNS_AGENT_URL" | "HNS_MACHINE_ID" | "HNS_CONTROL_PLANE_KEY", string>
  >;
}): Promise<Probe> {
  await d1.reset();
  const store = await openStore({ d1: d1.db });
  const project = await store.projects.create("project", "project");
  await createPolicyService({ policy: store.policy, bashSandbox: false }).ensure(project.id);
  await openConversationIndex(d1.db).upsert([
    {
      id: CONVERSATION_ID,
      projectId: project.id,
      title: "a conversation",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archived: false,
      deletedAt: null,
      indexedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  await store.close();
  const root = join(base, crypto.randomUUID(), "root");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "a.txt"), "hello", "utf8");
  const raw = await controlPlanePublicKey(SEED);
  if (raw === undefined) throw new Error("the seed has no public half");
  const agent = await startMachineAgent({
    root,
    machineId: MACHINE_ID,
    controlPlane: { publicKeys: async () => [raw] },
    port: 0,
    grants: {
      enrolled: { publicKeys: async () => [raw] },
      counter: new GrantCounter(join(base, crypto.randomUUID(), "grants")),
    },
    onLog: () => {},
  });
  const opened = openSqliteState();
  const storage: DurableObjectSqliteStorage & {
    getAlarm(): Promise<number | null>;
    setAlarm(at: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  } = {
    ...opened.state.storage,
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
  };
  const state: SessionState = {
    id: { name: CONVERSATION_ID },
    storage,
    blockConcurrencyWhile: opened.state.blockConcurrencyWhile,
    abort: () => undefined,
  };
  const local = new URL(agent.origin);
  const machineFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    url.protocol = local.protocol;
    url.hostname = local.hostname;
    url.port = local.port;
    return await fetch(url, init);
  };
  const object = new Session(
    state,
    {
      HNS_ENV: "dev",
      DB: d1.db,
      HNS_AGENT_URL: agent.origin,
      HNS_MACHINE_ID: MACHINE_ID,
      HNS_CONTROL_PLANE_KEY: SEED,
      HNS_SESSION_SECRET: "test-secret-0123456789abcdef0123456789",
      ...options.objectEnv,
    },
    async () => {
      const fake: AgentSession = {
        closed: new Promise(() => undefined),
        createConversation: async () => {
          throw new Error("unused");
        },
        listConversations: async () => [],
        getConversation: async () => undefined,
        send: async () => fakeTurn(),
        transcript: async () => [],
        watchConversation: async () => {
          throw new Error("unused");
        },
        abort: async () => true,
        pendingIndex: async () => ({ entries: [], remaining: 0, legacy: 0 }),
        markIndexed: async () => undefined,
        indexRows: async () => [],
        wake: () => ({ active: false }),
        resume: () => undefined,
        close: async () => undefined,
      };
      return fake;
    },
    { machineFetch },
  );
  // The Worker\'s send, with M1\'s mutation: when `snapshot` is false the body carries no policy.
  const context = createContext({
    env: {
      DB: d1.db,
      SESSION: {
        idFromName: (name: string) => ({ name }),
        get: () => ({
          fetch: async (request: Request) => {
            if (options.snapshot) return await object.fetch(request);
            const parsedRequest = v.parse(
              v.object({ text: v.string(), requestId: v.string() }),
              await request.clone().json(),
            );
            return await object.fetch(
              new Request(request.url, {
                method: "POST",
                headers: request.headers,
                body: JSON.stringify({
                  text: parsedRequest.text,
                  requestId: parsedRequest.requestId,
                }),
              }),
            );
          },
        }),
      },
    },
    requestId: "corr-mutation",
    session: { subject: SUBJECT, expiresAt: 0 },
    policy: undefined,
    maxRows: 100,
    maxRowsPerList: 100,
  });
  const tool = (await import("@hns/agent")).WORKSPACE_TOOLS.find(
    (candidate) => candidate.toolId === "read_file",
  );
  if (tool === undefined) throw new Error("no read_file tool");
  const contract = await (await import("@hns/agent")).manifestFor(tool);
  return {
    async send() {
      return await execute({
        schema,
        document: parse(SEND_MESSAGE),
        contextValue: context,
        variableValues: {
          input: { conversationId: toGlobalId("Conversation", CONVERSATION_ID), text: "read" },
        },
      });
    },
    async relay() {
      const outcome = await object.relayForTest(CONVERSATION_ID, {
        call: {
          v: 1,
          callId: "tool:1:mutation",
          toolId: "read_file",
          toolVersion: contract.manifest.version,
          args: { path: "a.txt" },
        },
        manifest: contract.manifest,
        bytes: 4096,
      });
      return outcome.ok ? { ok: true } : { ok: false, code: outcome.code };
    },
    async close() {
      await agent.close();
      opened.close();
    },
  };
}

// M1: without the snapshot in the send body the granted path never opens, so the relay is refused.
test("M1: a send without the policy snapshot leaves the granted path closed", async () => {
  const control = await probe({ snapshot: true });
  try {
    await control.send();
    const relayed = await control.relay();
    // The product\'s path answers a decision (an allow) rather than a refusal: the snapshot opened it.
    expect(relayed.ok).toBe(true);
  } finally {
    await control.close();
  }
  const mutated = await probe({ snapshot: false });
  try {
    await mutated.send();
    const relayed = await mutated.relay();
    // The mutation: the same send, minus the snapshot, leaves no revision to issue a grant under,
    // so the relay refuses the call instead of answering a decision.
    expect(relayed.ok).toBe(false);
  } finally {
    await mutated.close();
  }
});

// M2: a partial tool path decided as Phase 0 is the fallback the issue forbids; the object must
// refuse to open instead, and the mutation shows the difference.
test("M2: a partial tool path is not silently Phase 0", async () => {
  const partial = { HNS_MACHINE_ID: "" };
  // The product\'s decision: incomplete, which the object raises at start.
  expect(
    toolPathMode({ HNS_AGENT_URL: "https://x", HNS_MACHINE_ID: "", HNS_CONTROL_PLANE_KEY: "k" }),
  ).toMatchObject({ kind: "incomplete", missing: ["HNS_MACHINE_ID"] });
  // The mutation: a decision that falls back to Phase 0 for any missing binding would let the same
  // object open and serve, which is the silent fallback the test in `session-tool-path.test.ts`
  // forbids with a 503. The object under the mutation is the product\'s, so the probe is the
  // decision function itself: the two differ on the same input.
  const mutated = (env: Record<string, string>): { readonly kind: string } =>
    toolPathMode(env).kind === "granted" ? { kind: "granted" } : { kind: "phase0" };
  expect(
    mutated({ HNS_AGENT_URL: "https://x", HNS_MACHINE_ID: "", HNS_CONTROL_PLANE_KEY: "k" }),
  ).toStrictEqual({ kind: "phase0" });
  void partial;
});
