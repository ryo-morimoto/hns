import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { execute, parse, type ExecutionResult } from "graphql";
import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { AgentSession } from "@hns/agent/session";
import { toGlobalId } from "@hns/core/graphql";
import { WORKSPACE_TOOLS, manifestFor } from "@hns/agent";
import { ToolCallSchema } from "@hns/core/capability";
import * as v from "valibot";
import { openStore } from "../../../store/src/index.ts";
import { openConversationIndex } from "../../../store/src/conversation-index/index.ts";
import { createD1Harness, type D1Harness } from "../../../store/test/integration/harness.ts";
import { startMachineAgent, type MachineAgent } from "../../../machine/src/index.ts";

import { GrantCounter } from "../../../machine/src/capability/counter.ts";
import { controlPlanePublicKey } from "../../src/capability/signing.ts";
import { createPolicyService } from "../../src/policy/service.ts";
import { Session } from "../../src/do/session.ts";
import type { GrantedCallRequest } from "../../src/do/session-tools.ts";
import type { GrantedAnswer } from "@hns/workspace/protocol";
import type { RunGrantPathFactory } from "../../src/do/session.ts";
import type { SessionState } from "../../src/do/state.ts";
import { openSqliteState } from "../../test/support/sqlite.ts";
import { createContext } from "../../src/graphql/context.ts";
import { buildGraphQLSchema } from "../../src/graphql/schema.ts";
import { sendMessageModule } from "../../src/graphql/mutations/send-message.ts";

/**
 * (b) 0270n: `sendMessage` carries the policy snapshot, and 0226's granted path opens.
 *
 * @remarks
 * The chain is the product's, end to end:
 *
 * 1. the **real** GraphQL schema executes `Mutation.sendMessage`;
 * 2. the **real** `conversationPortOver` finds the conversation in a **real D1** index, reads the
 *    **real** active policy revision, and forwards the turn to the conversation's Session object
 *    through the `SESSION` binding — a stub whose `fetch` is the **real** `Session#fetch`;
 * 3. the real object admits the turn under that snapshot (`admitTurn`), so `#grantPathFor` opens;
 * 4. the run's own transport posts the object's `/rpc/conversations/<id>/tool` route, which checks
 *    the run token and relays the call;
 * 5. the relay reaches a **real `startMachineAgent`** — the machine's own listener, verifier,
 *    counter, and read operation — on loopback.
 *
 * Only the agent runtime (a fake that answers a conversation's send) and the relay fetch's origin
 * are seams. The bug this test exists for: the granted path had no Worker entry at all, so a
 * deployment never sent a snapshot and the machine never saw a grant.
 */

/** The control-plane seed; its public half is what the machine enrolled. */
const SEED = Buffer.from(new Uint8Array(32).fill(23)).toString("base64url");

const MACHINE_ID = "machine-0270n";
const CONVERSATION_ID = "conversation-1";
const SUBJECT = "person-1";

let d1: D1Harness;
let base = "";

beforeAll(async () => {
  d1 = await createD1Harness();
  base = await mkdtemp(join(tmpdir(), "hns-send-0270n-"));
});

afterAll(async () => {
  await d1.dispose();
  await rm(base, { recursive: true, force: true });
});

const SEND_MESSAGE =
  "mutation Send($input: SendMessageInput!) { sendMessage(input: $input) { __typename ... on SendMessagePayload { submissionId status } ... on MutationFailure { code message } } }";

const schema = buildGraphQLSchema([sendMessageModule()]);

/** The answer of a send whose fake runtime never runs a model. */
function fakeTurn(): Awaited<ReturnType<AgentSession["send"]>> {
  const turn = { settlement: { id: "1", status: "unanswered", reason: "test" }, text: "" };
  // SAFETY: the route reads only the settlement's id; this is the answer of a send whose model
  // never runs.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the fake is not the real Turn.
  return turn as unknown as Awaited<ReturnType<AgentSession["send"]>>;
}

/** The one member of the machine's log detail this test reads: the operation name. */
const LogDetailSchema = v.object({ op: v.optional(v.string()) });

/**
 * What the run's real-route relay answered.
 *
 * @remarks
 * The transport parses the object's answer and returns the decision, so this is either that
 * decision (an allow with its grant id and result, or a denial the object or the machine made) or
 * the typed failure the path reports when it could not relay.
 */
type RelayAnswer =
  | { readonly ok: true; readonly answer: GrantedAnswer }
  | {
      readonly ok: false;
      readonly code: "unavailable" | "grant_invalid" | "invalid_request" | string;
    };

/** One line the machine logged, as this test reads it. */
interface MachineLogLine {
  readonly op: string | undefined;
  readonly path: string;
  readonly status: number;
}

/**
 * What one chain gives a test: the mutation, the machine, and the object.
 *
 * @remarks
 * `relay` reaches the object the way the agent does: it asks the object for the run's granted path
 * (which mints the run's token), relays the call through that path's own transport, and so posts the
 * object's real `/rpc/conversations/<id>/tool` route with the token. Nothing here calls the object's
 * internal test seam: the route's token check, the body parse, the relay and the audit are all the
 * product's, which is the lesson 0226 wrote down ("本番の部品同士を突き合わせる").
 */
interface Chain {
  readonly send: (text: string, conversationId?: string) => Promise<ExecutionResult>;
  /** Relay one granted call through the run's own transport to the object's real route. */
  readonly relay: (request: GrantedCallRequest) => Promise<RelayAnswer>;
  /** What the machine's log recorded: the operations it served, and the status of each. */
  readonly machineLog: () => readonly MachineLogLine[];
  readonly agent: MachineAgent;
  readonly object: Session;
  readonly opened: ReturnType<typeof openSqliteState>;
  readonly close: () => Promise<void>;
}

/** Build the chain over a fresh D1 (one conversation row, one baseline policy) and a real agent. */
async function chain(): Promise<Chain> {
  await d1.reset();
  const store = await openStore({ d1: d1.db });
  const project = await store.projects.create("project", "project");
  await createPolicyService({ policy: store.policy, bashSandbox: false }).ensure(project.id);
  // The row is the Session's index write (D078): a conversation exists once an object wrote it,
  // which is what `get` reads ("a row the index holds").
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
  // The machine: the real agent, on loopback, with the key it enrolled.
  const root = join(base, crypto.randomUUID(), "root");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "a.txt"), "hello from the machine", "utf8");
  const machineLog: MachineLogLine[] = [];
  const raw = await controlPlanePublicKey(SEED);
  if (raw === undefined) throw new Error("the seed has no public half");
  const agent = await startMachineAgent({
    root,
    machineId: MACHINE_ID,
    // The keys the machine enrolled: the verifier's own source. (A `GrantKeys` lookup here is
    // what a first draft passed and every request was a 500; the types keep them apart.)
    controlPlane: { publicKeys: async () => [raw] },
    port: 0,
    // The same enrollment, for the granted path: a machine verifies a grant with the keys it
    // enrolled (`enrolled`), never with a key the grant carried.
    grants: {
      enrolled: { publicKeys: async () => [raw] },
      counter: new GrantCounter(join(base, crypto.randomUUID(), "grants")),
    },
    onLog: (entry) => {
      // The operation is the line's detail member (`ObsLogEntry`'s JSON detail), as the machine
      // writes it; the path is the ROOT-relative file the call named.
      const detail = v.parse(LogDetailSchema, entry.detail ?? {});
      machineLog.push({
        op: detail.op,
        path: entry.path ?? "",
        status: entry.status ?? 0,
      });
    },
  });
  // The object: the real Session, over an in-memory state, relaying to the agent's origin.
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
  // The relay's fetch, with the only change being the origin: the signature is the object's own.
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
  // The object hands the runtime the runs' granted-path factory (its fifth argument). This test
  // keeps it, so a relay can go through the run's own path and its transport — the same object the
  // agent's tool hooks would hold — rather than through the object's internal test seam.
  let grantPathOf: RunGrantPathFactory | undefined;
  const object = new Session(
    state,
    {
      HNS_ENV: "dev",
      DB: d1.db,
      HNS_AGENT_URL: agent.origin,
      HNS_MACHINE_ID: MACHINE_ID,
      HNS_CONTROL_PLANE_KEY: SEED,
      HNS_SESSION_SECRET: "test-secret-0123456789abcdef0123456789",
    },
    async (_state, _env, _hooks, _audit, of) => {
      grantPathOf = of;
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
  const context = createContext({
    env: {
      DB: d1.db,
      SESSION: {
        idFromName: (name: string) => ({ name }),
        get: () => ({ fetch: (request: Request) => object.fetch(request) }),
      },
    },
    requestId: "corr-0270n-send",
    session: { subject: SUBJECT, expiresAt: 0 },
    policy: undefined,
    maxRows: 100,
    maxRowsPerList: 100,
  });
  return {
    async send(text, conversationId = CONVERSATION_ID) {
      return await execute({
        schema,
        document: parse(SEND_MESSAGE),
        contextValue: context,
        variableValues: {
          input: { conversationId: toGlobalId("Conversation", conversationId), text },
        },
      });
    },
    async relay(input) {
      // The run's granted path exists only once a turn was admitted under a snapshot: asking for it
      // is what a tool call does in production, and it mints the run's route token.
      const path = grantPathOf?.(CONVERSATION_ID);
      if (path === undefined) {
        // The object's granted path is closed (no admitted snapshot): the route answers
        // `unavailable` to any call, so this test reports the same answer rather than a guess.
        return { ok: false, code: "unavailable" };
      }
      // The source is the object's issuer; the transport is the object's route with the run's token.
      const contract = await contractOf();
      const issued = await path.source.issue({
        toolId: "read_file",
        toolVersion: contract.manifest.version,
        manifestHash: contract.manifestHash,
        maxBytes: input.bytes,
      });
      if (!issued.ok) {
        return {
          ok: false,
          code: issued.decision.outcome === "deny" ? issued.decision.code : "invalid_request",
        };
      }
      const answer = await path.transport.call({
        call: v.parse(ToolCallSchema, input.call),
        contract,
        bytes: input.bytes,
        grant: issued.grant,
      });
      return { ok: true, answer };
    },
    machineLog: () => machineLog,
    agent,
    object,
    opened,
    async close() {
      await agent.close();
      opened.close();
    },
  };
}

/** The read_file tool's contract, as the agent builds it (the source's manifest check uses it). */
async function contractOf(): Promise<Awaited<ReturnType<typeof manifestFor>>> {
  const tool = WORKSPACE_TOOLS.find((candidate) => candidate.toolId === "read_file");
  if (tool === undefined) throw new Error("no read_file tool");
  return await manifestFor(tool);
}

/** The one read_file call this test relays, as the agent builds it. */
async function readCall(): Promise<{
  readonly call: unknown;
  readonly manifest: unknown;
  readonly bytes: number;
}> {
  const contract = await contractOf();
  return {
    call: {
      v: 1,
      callId: "tool:1:0270n",
      toolId: "read_file",
      toolVersion: contract.manifest.version,
      args: { path: "a.txt" },
    },
    manifest: contract.manifest,
    bytes: 4096,
  };
}

// The turn the mutation sends puts a snapshot in the object, which opens the run's granted path;
// the call the agent then relays reaches the real machine and is allowed, and the audit names the
// grant the machine spent.
test("sendMessage opens 0226's granted path and the machine runs the call", async () => {
  const fixture = await chain();
  try {
    const sent = await fixture.send("read a.txt");
    expect(sent).toMatchObject({
      data: {
        sendMessage: { __typename: "SendMessagePayload", status: "unanswered" },
      },
    });
    // The object admitted a policy: this is what a send without a snapshot would never do. The only
    // way to observe it from outside is the grant it enables, so the run's granted path asks for one
    // and relays the call **through the object's own route** (with the run's token).
    const relayed = await fixture.relay(await readCall());
    if (!relayed.ok) throw new Error("the relay failed: " + relayed.code);
    expect(relayed.answer.decision.outcome).toBe("allow");
    // The machine served the call: one line per request, the tool one on /rpc.
    // The log's path is the RPC path when the granted call is answered before a file path is
    // written; the operation and the status are what say the machine served the call.
    expect(fixture.machineLog()).toContainEqual(
      expect.objectContaining({ op: "tool", status: 200 }),
    );
    // The audit recorded the decision with the grant id the machine spent.
    const audit = fixture.opened.rows(
      "SELECT grant_id, decision_json FROM policy_audit WHERE event = 'tool.result'",
    );
    expect(audit).toHaveLength(1);
    expect(String(audit[0]?.["grant_id"] ?? "")).not.toBe("");
    // The grant the machine spent is the same id: the object's ledger and the machine agree.
    const ledger = fixture.opened.rows("SELECT grant_id FROM session_grants");
    expect(ledger.map((row) => String(row["grant_id"]))).toContain(String(audit[0]?.["grant_id"]));
  } finally {
    await fixture.close();
  }
});

// Catches: the object's route relaying a call that does not hold the run's token. The send face is
// what opens the granted path; the token it mints is what proves the caller is the run. A call
// without it must be refused before anything is issued or relayed (0226's NB2, from the send side).
test("the object's route refuses a granted call without the run's token", async () => {
  const fixture = await chain();
  try {
    expect((await fixture.send("read a.txt")).data).toMatchObject({
      sendMessage: { __typename: "SendMessagePayload" },
    });
    // Reach the real route directly, with no token: the send above opened the run's path, so the
    // refusal is the token check and not a closed path.
    const call = await readCall();
    const response = await fixture.object.fetch(
      new Request("https://session/rpc/conversations/" + CONVERSATION_ID + "/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(call),
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, code: "forbidden_internal" });
    // Nothing was issued and nothing reached the machine.
    expect(fixture.opened.rows("SELECT grant_id FROM session_grants")).toHaveLength(0);
    expect(fixture.machineLog()).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

// Catches: a send to a conversation D1 does not have being forwarded to an object anyway, which would
// let a caller create state by naming an id.
test("a conversation the index does not have is not_found", async () => {
  const fixture = await chain();
  try {
    const sent = await fixture.send("hello", "conversation-unknown");
    expect(sent).toMatchObject({
      data: { sendMessage: { __typename: "MutationFailure", code: "NOT_FOUND" } },
    });
    expect(fixture.machineLog()).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});
