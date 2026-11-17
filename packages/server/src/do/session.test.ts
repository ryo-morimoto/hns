import { expect, test } from "vitest";
import { openSqliteState } from "../../test/support/sqlite.ts";
import { createObsStore } from "../obs/store.ts";
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
  return new Session(state, {}, async () => fake.session, {
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
  const session = new Session(state, {}, async (_state, _env, hooks) => {
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

test("without a socket host the live face is unavailable", async () => {
  const base = fakeState();
  const state = {
    storage: base.storage,
    blockConcurrencyWhile: base.blockConcurrencyWhile,
    abort: base.abort,
  };
  const fake = fakeSession();
  const session = new Session(state, {}, async () => fake.session);
  const response = await session.fetch(upgrade());
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "unavailable" });
});
