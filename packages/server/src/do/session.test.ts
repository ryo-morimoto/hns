import type { ConversationId, EntryId, SubmissionId } from "@earendil-works/pi-durable";
import type { AgentEvent } from "@hns/agent";
import type { AgentSession } from "@hns/agent/session";
import type { SessionEnv } from "./state.ts";
import { expect, test, vi } from "vitest";
import { openFakeD1 } from "../../test/support/d1.ts";
import { openSqliteState } from "../../test/support/sqlite.ts";
import { createObsStore } from "../obs/store.ts";
import { ModelUnavailableError } from "./models.ts";
import {
  CONVERSATION,
  entry,
  fakeSession,
  fakeSocket,
  fakeState,
  testUpgradeResponse,
  view,
} from "../../test/support/live.ts";
import { Session } from "./session.ts";

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
): Session {
  return new Session(state, DEV, async () => fake.session, {
    webSocketPair: pair,
    now: () => 0,
    upgradeResponse: testUpgradeResponse,
  });
}

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
