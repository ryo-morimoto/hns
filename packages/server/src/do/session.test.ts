import type { ConversationId, EntryId, SubmissionId } from "@earendil-works/pi-durable";
import type { AgentEvent } from "@hns/agent";
import { isoTimestamp } from "@hns/core";
import type { AgentSession } from "@hns/agent/session";
import type { SessionEnv } from "./state.ts";
import { expect, test, vi } from "vitest";
import { openFakeD1 } from "../../../store/test/support/fake-d1.ts";
import { openSqliteState } from "../../test/support/sqlite.ts";
import { createObsStore } from "../obs/store.ts";
import { auditSink, createPolicyAudit, type PolicyAudit } from "./audit.ts";
import { ModelUnavailableError } from "./models.ts";
import {
  CONVERSATION,
  entry,
  fakeSession,
  fakeSocket,
  fakeState,
  parseFrames,
  testUpgradeResponse,
  view,
} from "../../test/support/live.ts";
import { Session, type SessionDependencies } from "./session.ts";
import type { CostGate } from "../cost/index.ts";

const PATH = "https://session/ws?conversationId=" + CONVERSATION.id;

/**
 * The bindings a unit test opens the object with.
 *
 * @remarks
 * Development and no control database: that is the one combination the Session opens without
 * `DB` (the cost gate and the index are then absent). A non-development binding without `DB`
 * is refused at open.
 */
const DEV: SessionEnv = { HNS_ENV: "dev" };

/** A settled answer for the routes that succeed. */
function answer(): Awaited<ReturnType<AgentSession["send"]>> {
  // SAFETY: pi-durable allocates these ids as positive integers and the RPC reads only the
  // settlement fields; the brands are compile-time only.
  const settlement = {
    id: 7 as SubmissionId,
    conversationId: 2 as ConversationId,
    type: "input",
    status: "done",
    entry: 3 as EntryId,
    answer: 4 as EntryId,
  } as const;
  return { settlement, text: "answered" };
}

/** An object state over real SQLite with the alarm methods the Session arms. */
function objectState() {
  const opened = openSqliteState();
  const storage = {
    ...opened.state.storage,
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
  };
  return {
    state: {
      storage,
      blockConcurrencyWhile: opened.state.blockConcurrencyWhile,
      abort: () => undefined,
    },
    storage,
    close: () => {
      opened.close();
    },
  };
}

function send(id: string): Request {
  return new Request("https://session/rpc/conversations/" + id + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "req-1" },
    body: JSON.stringify({ text: "hi" }),
  });
}

function upgrade(): Request {
  return new Request(PATH, { headers: { upgrade: "websocket" } });
}

function liveSession(
  state: ReturnType<typeof fakeState>,
  fake: ReturnType<typeof fakeSession>,
  pair: () => {
    readonly 0: ReturnType<typeof fakeSocket>;
    readonly 1: ReturnType<typeof fakeSocket>;
  },
  cost?: CostGate,
): Session {
  const common = {
    webSocketPair: pair,
    now: () => 0,
    upgradeResponse: testUpgradeResponse,
  };
  const dependencies: SessionDependencies = cost === undefined ? common : { ...common, cost };
  return new Session(state, DEV, async () => fake.session, dependencies);
}

/** A cost gate that records how often a turn is admitted and run, and admits everything. */
function countingGate(): CostGate & { readonly turns: string[] } {
  const turns: string[] = [];
  return {
    turns,
    admit: async () => undefined,
    turn: async (activity, run) => {
      turns.push(activity.conversationId);
      return await run();
    },
  };
}

// Catches: a socket send counting as two turns in the cost ledger — the socket re-enters the
// object's own turn route, and that route is the one place a turn is admitted and measured.
test("a send on the socket passes the cost gate exactly once", async () => {
  const state = fakeState();
  const server = fakeSocket();
  const fake = fakeSession();
  const cost = countingGate();
  const session = liveSession(state, fake, () => ({ 0: fakeSocket(), 1: server }), cost);
  await session.fetch(upgrade());

  await session.webSocketMessage(
    server,
    JSON.stringify({
      type: "send",
      conversationId: CONVERSATION.id,
      clientMessageId: "c1",
      text: "hi",
    }),
  );
  await vi.waitFor(() => {
    expect(fake.sends).toHaveLength(1);
  });

  expect(cost.turns).toStrictEqual([CONVERSATION.id]);

  // The same turn over the route the Worker uses is also one admission, so the socket adds
  // no second one.
  const answered = await session.fetch(send(CONVERSATION.id));
  expect(answered.status).toBe(200);
  expect(cost.turns).toStrictEqual([CONVERSATION.id, CONVERSATION.id]);
});

// Catches: /ws staying a 501 stub, or accepting a socket without arming the watch.
test("the Session upgrades /ws, accepts a hibernatable socket, and sends a snapshot", async () => {
  const state = fakeState();
  const client = fakeSocket();
  const server = fakeSocket();
  const fake = fakeSession();
  const session = liveSession(state, fake, () => ({ 0: client, 1: server }));

  const response = await session.fetch(upgrade());
  expect(response.status).toBe(200);
  expect(state.sockets).toStrictEqual([server]);
  expect(state.tags).toStrictEqual([[CONVERSATION.id]]);
  expect(server.sent).toHaveLength(1);
  expect(JSON.parse(server.sent[0] ?? "{}")).toMatchObject({
    type: "snapshot",
    cursor: "0",
    conversationId: CONVERSATION.id,
  });
  expect(server.attachment()).toStrictEqual({ conversationId: CONVERSATION.id, cursor: "0" });
});

// Catches: an eviction losing the subscription, so the re-created object never reattaches.
test("a re-created Session reattaches an accepted socket and resyncs it", async () => {
  const state = fakeState();
  const client = fakeSocket();
  const server = fakeSocket();
  const first = fakeSession();
  const session = liveSession(state, first, () => ({ 0: client, 1: server }));
  await session.fetch(upgrade());

  const second = fakeSession(view([entry(1, "pi.user", "hi")], "hel"));
  const revived = liveSession(state, second, () => ({ 0: fakeSocket(), 1: fakeSocket() }));
  await revived.fetch(new Request("https://session/rpc/conversations"));
  expect(server.sent).toHaveLength(2);
  expect(JSON.parse(server.sent[1] ?? "{}")).toMatchObject({
    type: "snapshot",
    cursor: "1",
    entries: [{ id: "1", kind: "pi.user", text: "hi" }],
    draft: "hel",
  });

  await revived.webSocketMessage(server, JSON.stringify({ type: "ping" }));
  expect(JSON.parse(server.sent.at(-1) ?? "{}")).toStrictEqual({ type: "pong", protocol: 1 });

  // A socket that outlived an eviction is still the client's live connection: a send and a stop
  // on it reach the object. A reattached connection without the chat port answers every send
  // `unavailable` — exactly when a client is most likely to resend one.
  await revived.webSocketMessage(
    server,
    JSON.stringify({
      type: "send",
      conversationId: CONVERSATION.id,
      clientMessageId: "after-wake",
      text: "still there?",
    }),
  );
  // The answer is written when the turn route returns, so it is awaited rather than assumed.
  await vi.waitFor(() => {
    expect(
      parseFrames(server).filter((frame) => frame.type === "accepted" || frame.type === "rejected"),
    ).toStrictEqual([{ type: "accepted", clientMessageId: "after-wake", messageId: "1" }]);
  });
  expect(second.sends).toStrictEqual([
    { id: CONVERSATION.id, text: "still there?", requestId: "after-wake" },
  ]);

  await revived.webSocketMessage(
    server,
    JSON.stringify({ type: "abort", conversationId: CONVERSATION.id }),
  );
  await vi.waitFor(() => {
    expect(second.aborts).toStrictEqual([CONVERSATION.id]);
  });

  await revived.webSocketClose(server);
  expect(second.stops()).toBe(1);
  const count = server.sent.length;
  second.push(view([entry(2, "pi.assistant", "after close")]));
  expect(server.sent).toHaveLength(count);
});

// Catches: a socket whose attachment was lost being attached to a guessed conversation.
test("a socket without an attachment is closed instead of guessed", async () => {
  const state = fakeState();
  const zombie = fakeSocket();
  state.sockets.push(zombie);
  const fake = fakeSession();
  const session = liveSession(state, fake, () => ({ 0: fakeSocket(), 1: fakeSocket() }));
  await session.fetch(new Request("https://session/rpc/conversations"));
  expect(zombie.closes).toStrictEqual([{ code: 1008, reason: "missing live attachment" }]);
});

// Catches: the DO hop and the agent event being unreadable, or the agent text reaching the log.
test("the Session records the DO hop and the agent event under one request id", async () => {
  const opened = openSqliteState();
  const storage = {
    ...opened.state.storage,
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
  };
  const state = {
    storage,
    blockConcurrencyWhile: opened.state.blockConcurrencyWhile,
    abort: () => undefined,
  };
  const fake = fakeSession();
  const session = new Session(state, DEV, async (_state, _env, hooks) => {
    hooks.onEvent({
      event: "agent.response",
      at: "2026-11-17T12:00:00.000Z",
      text: "super-secret-answer",
      requestId: "req-1",
      conversationId: CONVERSATION.id,
    });
    return fake.session;
  });
  try {
    const metrics = await session.fetch(
      new Request("https://session/rpc/metrics", { headers: { "x-request-id": "req-1" } }),
    );
    expect(metrics.status).toBe(200);
    const store = createObsStore(storage, {
      now: () => Date.parse("2026-11-17T12:00:01.000Z"),
    });
    const lines = store.list({ requestId: "req-1" });
    expect(lines.map((line) => line.event).sort()).toStrictEqual(["agent.response", "do.rpc"]);
    expect(lines.find((line) => line.hop === "agent")?.detail).toStrictEqual({
      conversationId: CONVERSATION.id,
    });
    expect(JSON.stringify(lines)).not.toContain("super-secret-answer");

    const read = await session.fetch(
      new Request("https://session/rpc/events?requestId=req-1", {
        headers: { "x-request-id": "req-1" },
      }),
    );
    expect(read.status).toBe(200);
    expect(JSON.stringify(await read.json())).not.toContain("super-secret-answer");
  } finally {
    opened.close();
  }
});

// Catches: a successful turn writing both the agent event and a duplicate do.rpc row.
test("a successful turn keeps one agent row and no do.rpc", async () => {
  const opened = objectState();
  const fake = fakeSession();
  let emit: ((event: AgentEvent) => void) | undefined;
  fake.session.send = async (_id: string, _text: string, requestId?: string) => {
    emit?.({
      event: "agent.response",
      at: "2026-11-17T12:00:00.000Z",
      text: "answer",
      requestId: requestId ?? "missing",
      conversationId: CONVERSATION.id,
    });
    return answer();
  };
  const session = new Session(opened.state, DEV, async (_state, _env, hooks) => {
    emit = hooks.onEvent;
    return fake.session;
  });
  try {
    const response = await session.fetch(send(CONVERSATION.id));
    expect(response.status).toBe(200);
    const store = createObsStore(opened.storage, {
      now: () => Date.parse("2026-11-17T12:00:01.000Z"),
    });
    expect(store.list({ requestId: "req-1" }).map((line) => line.event)).toStrictEqual([
      "agent.response",
    ]);
  } finally {
    opened.close();
  }
});

// Catches: a refused turn disappearing from the trace because the turn RPC was always skipped.
test("a refused turn still logs the DO hop", async () => {
  const opened = objectState();
  const fake = fakeSession();
  fake.session.send = async () => {
    throw new ModelUnavailableError("no model");
  };
  const session = new Session(opened.state, DEV, async () => fake.session);
  try {
    const response = await session.fetch(send(CONVERSATION.id));
    expect(response.status).toBe(503);
    const store = createObsStore(opened.storage, {
      now: () => Date.parse("2026-11-17T12:00:01.000Z"),
    });
    expect(store.list({ requestId: "req-1" }).map((line) => line.event)).toStrictEqual(["do.rpc"]);
  } finally {
    opened.close();
  }
});

test("without a socket host the live face is unavailable", async () => {
  const base = fakeState();
  const state = {
    storage: base.storage,
    blockConcurrencyWhile: base.blockConcurrencyWhile,
    abort: base.abort,
  };
  const fake = fakeSession();
  const session = new Session(state, DEV, async () => fake.session);
  const response = await session.fetch(upgrade());
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "unavailable" });
});

/**
 * A runtime factory that fails the way a missing model does, after the open.
 *
 * @remarks
 * The Session opens as usual and every request then answers 503; used to prove that a bound
 * control database is the only thing the open needs.
 */
async function failingRuntime(): Promise<AgentSession> {
  throw new ModelUnavailableError("no model");
}

// Catches: a deployment that forgot the control database serving work it cannot bound (no cost
// gauge, no limit), which is the fail-open the audit found.
test.each([
  ["staging", { HNS_ENV: "stg" }],
  ["production", { HNS_ENV: "prod" }],
  ["an unset environment", {}],
] as const)("%s without the control database does not open the Session", async (_label, env) => {
  const opened = objectState();
  const aborts: string[] = [];
  const state = { ...opened.state, abort: (reason?: string) => aborts.push(reason ?? "") };
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const session = new Session(state, env, failingRuntime);
  try {
    const response = await session.fetch(new Request("https://session/rpc/conversations"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "unavailable" });
    expect(aborts).toStrictEqual(["session open failed"]);
    // The log names the failure, never a binding value.
    const lines = errors.mock.calls.map((call) => call.join(" "));
    expect(lines.some((line) => line.includes("session open failed"))).toBe(true);
    expect(lines.join(" ")).not.toContain("control database binding is missing");
  } finally {
    errors.mockRestore();
    opened.close();
  }
});

// Catches: development losing the local unit path, where a Session runs without D1 on purpose.
test("development without the control database still opens the Session", async () => {
  const opened = objectState();
  const fake = fakeSession();
  const session = new Session(opened.state, DEV, async () => fake.session);
  try {
    const response = await session.fetch(new Request("https://session/rpc/conversations"));
    expect(response.status).toBe(200);
  } finally {
    opened.close();
  }
});

/**
 * A table that reads and verifies the real one but refuses every append.
 *
 * @remarks
 * The write failure a full disk or a locked database has: the read side still works, so a probe can
 * show the rows that were written before the failure and none after it.
 */
function refusingAudit(audit: PolicyAudit): PolicyAudit {
  return {
    append: async () => Promise.reject(new Error("the audit table is full")),
    list: (limit) => audit.list(limit),
    verify: () => audit.verify(),
  };
}

// Catches: the object opening without a policy audit, so no decision is ever recorded (0222).
test("the Session opens the policy audit and hands its sink to the runtime", async () => {
  const opened = objectState();
  let handed: ReturnType<typeof auditSink> | undefined;
  const session = new Session(opened.state, DEV, async (_state, _env, _hooks, audit) => {
    handed = auditSink(audit);
    return fakeSession().session;
  });
  try {
    await session.fetch(new Request("https://session/rpc/conversations"));
    expect(handed).toBeTypeOf("function");
    const read = await session.fetch(new Request("https://session/rpc/policy/audit"));
    expect(read.status).toBe(200);
    expect(await read.json()).toStrictEqual({ ok: true, rows: [] });
  } finally {
    opened.close();
  }
});

// C5: an append that fails refuses the call, and the refusal is the sink's rejection.
test("C5: a tool.call the audit cannot append refuses the call, and no result is recorded", async () => {
  const opened = objectState();
  const real = createPolicyAudit(opened.storage);
  let handed: ReturnType<typeof auditSink> | undefined;
  const session = new Session(opened.state, DEV, async (_state, _env, _hooks, audit) => {
    handed = auditSink(refusingAudit(audit));
    return fakeSession().session;
  });
  try {
    await session.fetch(new Request("https://session/rpc/conversations"));
    expect(handed).toBeTypeOf("function");
    const event = {
      v: 1 as const,
      event: "tool.call" as const,
      eventId: "e1",
      at: isoTimestamp("2026-11-17T12:00:00.000Z"),
      workspaceId: "w",
      sessionId: "s",
      callId: "tool:1:a",
      callHash: "1".repeat(64),
      argsHash: "2".repeat(64),
      toolId: "read_file" as const,
      toolVersion: "1",
      manifestHash: "3".repeat(64),
      prevHash: null,
      hash: "",
    };
    await expect(handed?.(event)).rejects.toThrow(/audit table is full/);
    expect(await real.list()).toHaveLength(0);
  } finally {
    opened.close();
  }
});

// C6: the RPC answers the object's rows ascending, within the limit, and refuses a bad limit.
test("C6: GET /rpc/policy/audit answers ascending rows and a closed limit", async () => {
  const opened = objectState();
  let handed: ReturnType<typeof auditSink> | undefined;
  const session = new Session(opened.state, DEV, async (_state, _env, _hooks, audit) => {
    handed = auditSink(audit);
    return fakeSession().session;
  });
  const event = (index: number) => ({
    v: 1 as const,
    event: "tool.call" as const,
    eventId: "e" + String(index),
    at: isoTimestamp("2026-11-17T12:00:00.000Z"),
    workspaceId: "w",
    sessionId: "s",
    callId: "tool:" + String(index) + ":a",
    callHash: "1".repeat(64),
    argsHash: "2".repeat(64),
    toolId: "read_file" as const,
    toolVersion: "1",
    manifestHash: "3".repeat(64),
    prevHash: null,
    hash: "",
  });
  try {
    await session.fetch(new Request("https://session/rpc/conversations"));
    for (let index = 1; index <= 3; index += 1) await handed?.(event(index));

    const all = await session.fetch(new Request("https://session/rpc/policy/audit"));
    expect(all.status).toBe(200);
    // SAFETY: the route's body is this module's own JSON (`json(body)`), whose shape it wrote.
    const body = (await all.json()) as { ok: boolean; rows: { seq: number; eventId: string }[] };
    expect(body.ok).toBe(true);
    expect(body.rows.map((row) => row.seq)).toStrictEqual([1, 2, 3]);
    expect(body.rows.map((row) => row.eventId)).toStrictEqual(["e1", "e2", "e3"]);

    const one = await session.fetch(new Request("https://session/rpc/policy/audit?limit=1"));
    // SAFETY: as above: the route wrote this JSON.
    const page = (await one.json()) as { rows: { seq: number }[] };
    expect(page.rows.map((row) => row.seq)).toStrictEqual([3]);
    const tooMany = await session.fetch(new Request("https://session/rpc/policy/audit?limit=201"));
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({ ok: false, code: "invalid_request" });
    const zero = await session.fetch(new Request("https://session/rpc/policy/audit?limit=0"));
    expect(zero.status).toBe(400);
    const wrong = await session.fetch(
      new Request("https://session/rpc/policy/audit", { method: "POST" }),
    );
    expect(wrong.status).toBe(405);
  } finally {
    opened.close();
  }
});

// Catches: a non-development open being refused even though the database is bound.
test("a bound control database opens a non-development Session", async () => {
  const opened = objectState();
  const fake = fakeSession();
  const d1 = openFakeD1();
  const session = new Session(
    opened.state,
    { HNS_ENV: "prod", DB: d1.db },
    async () => fake.session,
  );
  try {
    const response = await session.fetch(new Request("https://session/rpc/conversations"));
    expect(response.status).toBe(200);
  } finally {
    opened.close();
    d1.close();
  }
});
