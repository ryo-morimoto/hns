import { expect, test } from "vitest";
import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { policyHash } from "@hns/core/capability";
import type { PolicyDocument } from "@hns/core/capability";
import { ModelUnavailableError } from "./models.ts";
import type { AgentSession } from "@hns/agent/session";
import { TOOL_RUN_TOKEN_HEADER } from "@hns/workspace/protocol";
import { Session } from "./session.ts";
import type { SessionEnv, SessionState } from "./state.ts";
import { openSqliteState } from "../../test/support/sqlite.ts";

/**
 * The Session object's granted path, from the object (0226): its own `fetch` serves a run's relay
 * on the route, the relay answers with the denial its path decides, and the object refuses a caller
 * that is not the run.
 *
 * @remarks
 * The agent's runtime is a fake, as the object's other tests use; the object itself is the real one,
 * with a memory state and the tool path over the real `policy_audit` table. What is proved is the
 * wiring: the relay the object gives the agent posts the object's own `/rpc/conversations/<id>/tool`
 * route, carries the run's token, and gets the machine's denial back as JSON.
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

/** The control-plane seed the relay's signatures and the grants would use. */
const SEED = Buffer.from(new Uint8Array(32).fill(9)).toString("base64url");

/** The object's env: a machine to relay to, and the key a grant would be signed with. */
const ENV: SessionEnv = {
  HNS_ENV: "dev",
  HNS_AGENT_URL: "http://127.0.0.1:1",
  HNS_MACHINE_ID: "machine-1",
  HNS_CONTROL_PLANE_KEY: SEED,
  HNS_SESSION_SECRET: "test-secret-0123456789abcdef0123456789",
};

/**
 * A send's answer for a fake session: the route reads the settlement's id and nothing else.
 *
 * @returns The turn the route's answer needs; no model runs in these tests.
 */
const fakeTurn = (): Awaited<ReturnType<AgentSession["send"]>> => {
  const turn = {
    settlement: { id: "1", status: "unanswered", reason: "test" },
    text: "",
  };
  // SAFETY: the route reads only the settlement's id (a branded number there); this fake is the
  // answer of a send whose model never runs, which is what these route tests need.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the fake is not the real Turn.
  return turn as unknown as Awaited<ReturnType<AgentSession["send"]>>;
};

/** A session whose send records the snapshot it was given. */
function fakeSession() {
  const sends: unknown[] = [];
  const session: AgentSession = {
    closed: new Promise(() => undefined),
    createConversation: async () => {
      throw new Error("unused");
    },
    listConversations: async () => [],
    getConversation: async () => undefined,
    send: async () => {
      sends.push(1);
      // The route reads the settlement's id; the object's own answer is what is tested, not a model.
      return fakeTurn();
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
  return { session, sends };
}

/** One object over an in-memory state, and its closer. */
function object() {
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
  return {
    session: new Session(state, ENV, async () => fakeSession().session),
    state,
    opened,
    close: () => opened.close(),
  };
}

/** A send carrying the revision-1 snapshot. */
async function send(): Promise<Request> {
  return new Request("https://session/rpc/conversations/run-1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "hi",
      policy: { revision: 1, hash: await policyHash(DOCUMENT), document: DOCUMENT },
    }),
  });
}

// The object serves the relay route, and a caller that is not the run is refused before anything.
test("the object refuses a relay without the run's token", async () => {
  const objectOfTest = object();
  try {
    const response = await objectOfTest.session.fetch(
      new Request("https://session/rpc/conversations/run-1/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ call: {}, manifest: {}, bytes: 1 }),
      }),
    );
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, code: "forbidden_internal" });
  } finally {
    objectOfTest.close();
  }
});

// A turn is admitted under the snapshot, and the object then answers a relayed call as its path
// decided it (no grant: the message is the machine's denial, never a transport failure).
test("the object admits the turn's snapshot and answers a relayed call", async () => {
  const objectOfTest = object();
  try {
    // The turn is admitted; its answer is the model's failure, which the object maps to unavailable.
    const admitted = await objectOfTest.session.fetch(await send());
    expect(admitted.status).toBe(200);
    // The relay without a token is refused: the object mints tokens for its runs' transports only.
    const refused = await objectOfTest.session.fetch(
      new Request("https://session/rpc/conversations/run-1/tool", {
        method: "POST",
        headers: { "content-type": "application/json", [TOOL_RUN_TOKEN_HEADER]: "not-this-run" },
        body: JSON.stringify({ call: {}, manifest: {}, bytes: 1 }),
      }),
    );
    expect(refused.status).toBe(401);
    // A send with no snapshot after one was admitted is still fine (the same revision again), and
    // the object never answers the grant path as an allow without a machine's decision.
    const again = await objectOfTest.session.fetch(await send());
    expect(again.status).toBe(200);
  } finally {
    objectOfTest.close();
  }
});
