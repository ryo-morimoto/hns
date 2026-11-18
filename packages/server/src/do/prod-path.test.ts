import { afterAll, beforeAll, expect, test } from "vitest";
import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import * as v from "valibot";
import type { JsonValue } from "@hns/core";
import { SignedGrantSchema, ToolCallSchema, policyHash } from "@hns/core/capability";
import type { PolicyDocument } from "@hns/core/capability";
import type { AgentSession } from "@hns/agent/session";
import { WORKSPACE_TOOLS, manifestFor, type GrantSource, type ToolTransport } from "@hns/agent";
import { PolicySnapshotBodySchema, TOOL_RUN_TOKEN_HEADER } from "@hns/workspace/protocol";
import { openStore } from "../../../store/src/index.ts";
import { createD1Harness, type D1Harness } from "../../../store/test/integration/harness.ts";
import { createPolicyService } from "../policy/service.ts";
import { Session } from "./session.ts";
import type { GrantedCallRequest, ToolRelayOutcome } from "./session-tools.ts";
import type { SessionEnv, SessionState } from "./state.ts";
import { openSqliteState } from "../../test/support/sqlite.ts";

/**
 * The production path of a granted call, from the object (0226 B1): the **object's own** run
 * transport posts its **own** `/rpc/conversations/<run>/tool` route, the route reads the body the
 * transport wrote, the object issues through its real issuer, and the relay reaches the machine.
 *
 * @remarks
 * The agent's runtime is a fake (it answers the conversation) and the machine is the only wire
 * stubbed (the `machineFetch` seam). Everything between is the product: the object's
 * `#grantPathFor` and `#runTransport`, the transport's route call, the route's token check,
 * `GrantedCallRequestSchema`, `relayOne`, the real 0224 issuer over the object's SQLite, and the
 * audit. The bug this test exists for: the transport's body and the route's parse had drifted
 * apart, so every granted call was `invalid_request` while its grant was being issued.
 */

const DOCUMENT: PolicyDocument = {
  v: 1,
  tools: {
    read_file: {
      enabled: true,
      scope: { kind: "read", roots: ["."] },
      grantTtlSeconds: 60,
      maxCallsPerGrant: 10,
    },
  },
  egress: { enabled: false, hosts: [] },
};

/** The control-plane seed the relay's signatures and the grants use. */
const SEED = Buffer.from(new Uint8Array(32).fill(19)).toString("base64url");

const MACHINE_ORIGIN = "http://127.0.0.1:8788";

let d1: D1Harness;

beforeAll(async () => {
  d1 = await createD1Harness();
});

afterAll(async () => {
  await d1.dispose();
});

/** A send's answer for a fake session: the route reads the settlement's id. */
const fakeTurn = (): Awaited<ReturnType<AgentSession["send"]>> => {
  const turn = {
    settlement: { id: "1", status: "unanswered", reason: "test" },
    text: "",
  };
  // SAFETY: the route reads only the settlement's id; this is the answer of a send whose model
  // never runs.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the fake is not the real Turn.
  return turn as unknown as Awaited<ReturnType<AgentSession["send"]>>;
};

/** One run's granted path, as the object keeps it. */
interface RunPath {
  readonly source: GrantSource;
  readonly transport: ToolTransport;
}

/** The object hands the runtime the runs' granted path factory (its fifth argument). */
type RunPathFactory = (runId: string) => RunPath | undefined;

/** One object whose machine wire is a fake, and what it did. */
interface Fixture {
  readonly session: Session;
  readonly machineRequests: { readonly url: string; readonly body: unknown }[];
  /** The granted path the object built for a run, as the runtime received it. */
  readonly pathOf: (runId: string) => RunPath | undefined;
  /** The grants the object's ledger recorded, with the run each was bound to. */
  readonly ledger: () => readonly {
    readonly grantId: string;
    readonly runId: string | null;
    readonly revokedAt: string | null;
  }[];
  /** Ask the object's path to relay one call, as its own route does after the token check. */
  readonly relayPath: (runId: string, body: GrantedCallRequest) => Promise<ToolRelayOutcome>;
  readonly close: () => void;
}

/** The URL a fetch was called with, whichever of its forms it took. */
function requestUrl(input: string | URL | Request): string {
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return input;
}

/** A request body as text: the relay sends the signed bytes. */
function decodeBody(body: BodyInit | null | undefined): string {
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof Request) throw new Error("the granted path sends bytes, not a request");
  return v.parse(v.string(), body ?? "{}");
}

/**
 * Open one object over a real D1 policy and its own SQLite, with a fake machine wire.
 *
 * @param onMachine - What the fake machine answers for one granted call.
 */
async function openObject(onMachine: () => Response): Promise<Fixture> {
  await d1.reset();
  const store = await openStore({ d1: d1.db });
  const service = createPolicyService({ policy: store.policy, bashSandbox: false });
  await service.ensure("project-1");
  await store.close();
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
    id: { name: "project-1" },
    storage,
    blockConcurrencyWhile: opened.state.blockConcurrencyWhile,
    abort: () => undefined,
  };
  const env: SessionEnv = {
    HNS_ENV: "dev",
    // The policy is read through the control database the Worker would use.
    DB: d1.db,
    HNS_AGENT_URL: MACHINE_ORIGIN,
    HNS_MACHINE_ID: "machine-1",
    HNS_CONTROL_PLANE_KEY: SEED,
    HNS_SESSION_SECRET: "test-secret-0123456789abcdef0123456789",
  };
  const machineRequests: { url: string; body: unknown }[] = [];
  // The machine's wire: the object's granted path relays through this seam, so its route, token
  // check, and relay stay real.
  const machineFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    machineRequests.push({ url: requestUrl(input), body: JSON.parse(decodeBody(init?.body)) });
    return onMachine();
  };
  // The runtime factory is the seam: the object passes it the runs' granted path factory.
  let grantPathOf: RunPathFactory | undefined;
  const session = new Session(
    state,
    env,
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
        // The run's abort ends it: the object then revokes what the conversation held.
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
  return {
    session,
    machineRequests,
    pathOf: (runId) => grantPathOf?.(runId),
    ledger: () =>
      opened.rows("SELECT grant_id, run_id, revoked_at FROM session_grants").map((row) => ({
        grantId: String(row["grant_id"] ?? ""),
        runId: row["run_id"] === null ? null : String(row["run_id"]),
        revokedAt: row["revoked_at"] === null ? null : String(row["revoked_at"]),
      })),
    relayPath: (runId, body) => session.relayForTest(runId, body),
    close: () => {
      opened.close();
    },
  };
}

/** The snapshot body the Worker sends: the real D1 revision, as JSON. */
async function snapshotBody(): Promise<Readonly<Record<string, JsonValue>>> {
  const store = await openStore({ d1: d1.db });
  try {
    const active = await store.policy.active("project-1");
    if (active === undefined) throw new Error("no active policy");
    return v.parse(PolicySnapshotBodySchema, {
      revision: active.revision,
      hash: await policyHash(DOCUMENT),
      document: DOCUMENT,
    });
  } finally {
    await store.close();
  }
}

/** One turn's send, carrying the snapshot (a granted turn). */
async function send(): Promise<Request> {
  return new Request("https://session/rpc/conversations/run-1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hi", policy: await snapshotBody() }),
  });
}

/**
 * The machine's answer: a denial (the machine's own verifier is not this test's subject).
 *
 * @returns A fresh response: a body is read once.
 */
function machineDenial(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      op: "tool",
      result: { decision: { outcome: "deny", code: "scope_exceeded", message: "outside" } },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** The answer the object's relay route gives the agent: a machine's decision. */
const RelayAnswerSchema = v.union([
  v.object({ ok: v.literal(false), code: v.string(), message: v.string() }),
  v.object({ decision: v.object({ outcome: v.literal("deny"), code: v.string() }) }),
  v.object({
    decision: v.object({ outcome: v.literal("allow") }),
    grantId: v.string(),
    result: v.unknown(),
  }),
]);

/** The body the object relays to a machine, as its schema reads it. */
const MachineBodySchema = v.object({
  op: v.literal("tool"),
  authorization: SignedGrantSchema,
  call: ToolCallSchema,
  activePolicy: v.object({ revision: v.number(), hash: v.string() }),
  bytes: v.number(),
});

/** The call the object relays, as the agent builds it for a read. */
async function readCall(): Promise<Awaited<ReturnType<typeof manifestFor>>> {
  const tool = WORKSPACE_TOOLS.find((candidate) => candidate.toolId === "read_file");
  if (tool === undefined) throw new Error("no read_file tool");
  return await manifestFor(tool);
}

// The object's own transport reaches its own route, which reads what it wrote and relays it: the
// granted call is issued, sent to the machine's origin, and recorded, never `invalid_request`.
test("B1: the object's transport and its route agree on one granted call", async () => {
  const fixture = await openObject(machineDenial);
  try {
    expect((await fixture.session.fetch(await send())).status).toBe(200);
    const path = fixture.pathOf("run-1");
    if (path === undefined) throw new Error("the run has no granted path");
    const contract = await readCall();
    const issued = await path.source.issue({
      toolId: "read_file",
      toolVersion: contract.manifest.version,
      manifestHash: contract.manifestHash,
      maxBytes: 4096,
    });
    if (!issued.ok) throw new Error("the object refused the grant");
    const answer: unknown = await path.transport.call({
      call: {
        v: 1,
        callId: "tool:1:prod",
        toolId: "read_file",
        toolVersion: contract.manifest.version,
        args: { path: "a.txt" },
      },
      contract,
      bytes: 4096,
      grant: issued.grant,
    });
    // The route read the body the transport wrote and relayed it: the machine was asked, at its
    // configured origin, with a grant the object's ledger recorded for this run.
    expect(fixture.machineRequests).toHaveLength(1);
    expect(fixture.machineRequests[0]?.url).toBe(MACHINE_ORIGIN + "/rpc");
    const relayed = v.parse(MachineBodySchema, fixture.machineRequests[0]?.body);
    expect(relayed.call.callId).toBe("tool:1:prod");
    expect(relayed.authorization.payload.machineId).toBe("machine-1");
    expect(relayed.activePolicy.revision).toBe(1);
    expect(fixture.ledger().map((record) => record.grantId)).toContain(
      relayed.authorization.payload.grantId,
    );
    expect(answer).toMatchObject({ decision: { outcome: "deny", code: "scope_exceeded" } });
  } finally {
    fixture.close();
  }
});

// The route reads the call where the transport writes it: the old nested shape is the B1 bug and
// must be refused as a request, never relayed.
test("B1: a body the route cannot read as a call is refused, and nothing is relayed", async () => {
  const fixture = await openObject(machineDenial);
  try {
    await fixture.session.fetch(await send());
    // The run's path (and so its relay token) is minted when a tool call asks for it.
    fixture.pathOf("run-1");
    const token = fixture.session.runToken("run-1");
    const headers = new Headers({ "content-type": "application/json" });
    if (token !== null) headers.set(TOOL_RUN_TOKEN_HEADER, token);
    const response = await fixture.session.fetch(
      new Request("https://session/rpc/conversations/run-1/tool", {
        method: "POST",
        headers,
        // The old transport's shape: the call nested inside a wrapper object.
        body: JSON.stringify({
          call: { call: { v: 1 }, manifest: null },
          manifest: null,
          bytes: 1,
        }),
      }),
    );
    expect(await response.json()).toMatchObject({ ok: false, code: "invalid_request" });
    expect(fixture.machineRequests).toHaveLength(0);
  } finally {
    fixture.close();
  }
});

// The grant a run is issued is bound to its conversation, so the run's abort revokes it: the call
// after the abort is refused `grant_revoked`, and nothing runs (NB2).
test("NB2: a run's abort revokes its grant by its conversation", async () => {
  const fixture = await openObject(machineDenial);
  try {
    await fixture.session.fetch(await send());
    const contract = await readCall();
    // One granted call through the object's relay: the grant it issues for the run is the run's.
    const first = await fixture.relayPath("run-1", {
      call: {
        v: 1,
        callId: "tool:1:before-abort",
        toolId: "read_file",
        toolVersion: contract.manifest.version,
        args: { path: "a.txt" },
      },
      manifest: contract.manifest,
      bytes: 4096,
    });
    if (!first.ok) throw new Error("the object should answer a decision: " + first.code);
    // The grant is bound to the run: the object's ledger has it under the conversation's id.
    const bound = await fixture.ledger();
    expect(bound).toContainEqual(expect.objectContaining({ runId: "run-1" }));
    const grantId = bound.find((record) => record.runId === "run-1")?.grantId ?? "";
    // The run's abort revokes what it held, before the abort answers. (It also forgets the run's
    // relay token: the run is over, and nothing may relay as it again.)
    const aborted = await fixture.session.fetch(
      new Request("https://session/rpc/conversations/run-1/abort", { method: "POST" }),
    );
    expect(aborted.status).toBe(200);
    const afterAbort = await fixture.ledger();
    expect(afterAbort).toContainEqual(
      expect.objectContaining({ grantId, revokedAt: expect.any(String) }),
    );
    // The object's relay of the run's revoked grant is refused before any machine is asked, well
    // inside the grant's TTL: the run's end, not the expiry, is what stopped it.
    const relayed = await fixture.relayPath("run-1", {
      call: {
        v: 1,
        callId: "tool:2:after-abort",
        toolId: "read_file",
        toolVersion: contract.manifest.version,
        args: { path: "a.txt" },
      },
      manifest: contract.manifest,
      bytes: 4096,
    });
    if (!relayed.ok) throw new Error("the relay failed: " + relayed.code + " " + relayed.message);
    expect(relayed.answer.decision).toMatchObject({ outcome: "deny", code: "grant_revoked" });
    // Only the call before the abort reached the machine: the revoked grant never did.
    expect(fixture.machineRequests).toHaveLength(1);
  } finally {
    fixture.close();
  }
});

// The turn an abort ended is refused; the conversation's next turn is granted afresh, so an abort
// does not leave a conversation without tools (the regression this test exists for).
test("after an abort the same conversation's next turn is granted afresh", async () => {
  const fixture = await openObject(machineDenial);
  try {
    await fixture.session.fetch(await send());
    const contract = await readCall();
    const call = (callId: string) =>
      ({
        v: 1,
        callId,
        toolId: "read_file",
        toolVersion: contract.manifest.version,
        args: { path: "a.txt" },
      }) as const;
    const first = await fixture.relayPath("run-1", {
      call: call("tool:1:before-abort"),
      manifest: contract.manifest,
      bytes: 4096,
    });
    if (!first.ok) throw new Error("the object should answer a decision");
    const before = (await fixture.ledger()).find((record) => record.runId === "run-1");
    if (before === undefined) throw new Error("the run held no grant");
    // The abort ends the turn: its grant is revoked, and a relay of it is refused.
    expect(
      (
        await fixture.session.fetch(
          new Request("https://session/rpc/conversations/run-1/abort", { method: "POST" }),
        )
      ).status,
    ).toBe(200);
    const ended = await fixture.relayPath("run-1", {
      call: call("tool:2:ended-turn"),
      manifest: contract.manifest,
      bytes: 4096,
    });
    if (!ended.ok) throw new Error("the object should answer a decision");
    expect(ended.answer.decision).toMatchObject({ outcome: "deny", code: "grant_revoked" });
    // The conversation's next turn begins with its send: the run is granted again, with its own
    // grant, and its tools work.
    expect((await fixture.session.fetch(await send())).status).toBe(200);
    const next = await fixture.relayPath("run-1", {
      call: call("tool:3:next-turn"),
      manifest: contract.manifest,
      bytes: 4096,
    });
    if (!next.ok)
      throw new Error("the next turn's relay failed: " + next.code + " " + next.message);
    expect(next.answer.decision).toMatchObject({ outcome: "deny", code: "scope_exceeded" });
    // A new grant, not the revoked one; the revoked row is still the ledger's fact.
    const ledger = await fixture.ledger();
    expect(ledger).toContainEqual(
      expect.objectContaining({ grantId: before.grantId, revokedAt: expect.any(String) }),
    );
    const issued = ledger.filter((record) => record.runId === "run-1" && record.revokedAt === null);
    expect(issued).toHaveLength(1);
    expect(issued[0]?.grantId).not.toBe(before.grantId);
  } finally {
    fixture.close();
  }
});

// A run keeps one granted path (and so one grant cache) across its turns (NB1).
test("NB1: a run has one granted path across its turns", async () => {
  const fixture = await openObject(machineDenial);
  try {
    await fixture.session.fetch(await send());
    const first = fixture.pathOf("run-1");
    expect(first).toBeDefined();
    expect((await fixture.session.fetch(await send())).status).toBe(200);
    expect(fixture.pathOf("run-1")).toBe(first);
  } finally {
    fixture.close();
  }
});
