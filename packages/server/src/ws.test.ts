import type { LiveFrame, LiveSnapshotFrame } from "@hns/core";
import { afterEach, expect, test, vi } from "vitest";
import {
  CONVERSATION,
  entry,
  fakeHost,
  fakeSession,
  fakeSocket,
  framesOf,
  testUpgradeResponse,
  view,
  type FakeSocket,
} from "../test/support/live.ts";
import { LiveConnection, openLiveSocket } from "./ws.ts";

afterEach(() => {
  vi.useRealTimers();
});

function upgradeRequest(id: string = CONVERSATION.id): Request {
  return new Request("https://session/ws?conversationId=" + id, {
    headers: { upgrade: "websocket" },
  });
}

function frames(socket: FakeSocket): LiveFrame[] {
  return framesOf(socket);
}

function snapshot(socket: FakeSocket): LiveSnapshotFrame {
  const first = frames(socket)[0];
  expect(first?.type).toBe("snapshot");
  if (first?.type !== "snapshot") throw new Error("the first frame is not a snapshot");
  return first;
}

async function open(
  options: {
    readonly host?: ReturnType<typeof fakeHost>;
    readonly client?: FakeSocket;
    readonly server?: FakeSocket;
    readonly fake?: ReturnType<typeof fakeSession>;
    readonly request?: Request;
    readonly pair?: () => { readonly 0: FakeSocket; readonly 1: FakeSocket };
  } = {},
) {
  const client = options.client ?? fakeSocket();
  const server = options.server ?? fakeSocket();
  const host = options.host ?? fakeHost();
  const fake = options.fake ?? fakeSession();
  const result = await openLiveSocket({
    request: options.request ?? upgradeRequest(),
    host,
    pair: options.pair ?? (() => ({ 0: client, 1: server })),
    session: fake.session,
    now: () => 0,
    upgradeResponse: testUpgradeResponse,
  });
  return { result, client, server, host, fake };
}

// Catches: a connection that emits appends before the snapshot, or never sends the cursor.
test("a live connection starts with a cursor-bearing snapshot", async () => {
  const { result, client, server, host } = await open();
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.client).toBe(client);
  expect(host.accepted).toStrictEqual([server]);
  expect(host.tags).toStrictEqual([[CONVERSATION.id]]);
  expect(snapshot(server)).toMatchObject({
    type: "snapshot",
    protocol: 1,
    cursor: "0",
    conversationId: CONVERSATION.id,
    title: "Live",
    entries: [],
    draft: "",
  });
  expect(server.attachment()).toStrictEqual({ conversationId: CONVERSATION.id, cursor: "0" });
});

// Catches: durable entries arriving after draft text, or a per-token frame for a coalesced draft.
test("entries append before a throttled draft delta", async () => {
  vi.useFakeTimers();
  const { result, server, fake } = await open();
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  fake.push(view([entry(1, "pi.user", "hi")], "hel"));
  expect(frames(server).map((frame) => frame.type)).toStrictEqual(["snapshot", "append"]);
  const appended = frames(server)[1];
  expect(appended).toMatchObject({
    type: "append",
    cursor: "1",
    entries: [{ id: "1", kind: "pi.user", text: "hi" }],
  });
  expect(server.attachment()).toStrictEqual({ conversationId: CONVERSATION.id, cursor: "1" });

  vi.advanceTimersByTime(100);
  expect(frames(server).map((frame) => frame.type)).toStrictEqual(["snapshot", "append", "delta"]);
  expect(frames(server)[2]).toMatchObject({ type: "delta", text: "hel", replace: false });
});

// Catches: a reconnect that resumes from an empty state and loses entries committed while away.
test("a reconnect snapshot contains what was committed while disconnected", async () => {
  const first = await open();
  expect(first.result.ok).toBe(true);
  if (!first.result.ok) return;
  first.result.value.connection.close();

  first.fake.push(view([entry(1, "pi.user", "hi"), entry(2, "pi.assistant", "hello")]));
  const second = await open({ fake: first.fake });
  expect(second.result.ok).toBe(true);
  if (!second.result.ok) return;

  const current = snapshot(second.server);
  expect(current.cursor).toBe("2");
  expect(current.entries.map((item) => item.id)).toStrictEqual(["1", "2"]);
  expect(current.entries[1]?.text).toBe("hello");
});

test("ping answers pong and unknown input is a typed error", async () => {
  const { result, server } = await open();
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const connection = result.value.connection;

  connection.handleMessage(JSON.stringify({ type: "ping" }));
  expect(frames(server).at(-1)).toStrictEqual({ type: "pong", protocol: 1 });

  connection.handleMessage("not json");
  expect(frames(server).at(-1)).toMatchObject({ type: "error", code: "invalid_request" });

  connection.handleMessage(JSON.stringify({ type: "subscribe" }));
  expect(frames(server).at(-1)).toMatchObject({ type: "error", code: "invalid_request" });
});

test("resync sends the latest snapshot again", async () => {
  const { result, server, fake } = await open();
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  fake.push(view([entry(1, "pi.user", "hi")]));
  const connection = result.value.connection;
  connection.handleMessage(JSON.stringify({ type: "resync" }));
  const last = frames(server).at(-1);
  expect(last).toMatchObject({ type: "snapshot", cursor: "1" });
});

// Catches: a closed socket still receiving view updates after the client went away.
test("closing stops further frames", async () => {
  const { result, server, fake } = await open();
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const count = server.sent.length;
  await result.value.watch.stop();
  result.value.connection.close();
  fake.push(view([entry(1, "pi.user", "hi")]));
  expect(server.sent).toHaveLength(count);
});

test("a draft that is replaced is sent with replace, not appended", () => {
  const socket = fakeSocket();
  const connection = new LiveConnection(socket, CONVERSATION.id, { now: () => 0 });
  const fake = fakeSession();
  connection.start(fake.initial());
  connection.advance(view([], "first"));
  connection.advance(view([], "second"));
  const delta = frames(socket).at(-1);
  expect(delta).toMatchObject({ type: "delta", text: "second", replace: true });
});

test("non-upgrade, missing id, invalid id, unknown conversation and no pair fail closed", async () => {
  const noUpgrade = await open({
    request: new Request("https://session/ws?conversationId=" + CONVERSATION.id),
  });
  expect(noUpgrade.result.ok).toBe(false);
  if (noUpgrade.result.ok) return;
  expect(noUpgrade.result.error.status).toBe(426);

  const missing = await open({
    request: new Request("https://session/ws", { headers: { upgrade: "websocket" } }),
  });
  expect(missing.result.ok).toBe(false);
  if (missing.result.ok) return;
  expect(missing.result.error.status).toBe(400);

  const invalid = await open({ request: upgradeRequest("not-a-number") });
  expect(invalid.result.ok).toBe(false);
  if (invalid.result.ok) return;
  expect(invalid.result.error.status).toBe(400);

  const fake = fakeSession();
  fake.setMissing(true);
  const unknown = await open({ fake });
  expect(unknown.result.ok).toBe(false);
  if (unknown.result.ok) return;
  expect(unknown.result.error.status).toBe(404);

  const noPair = await open({
    pair: () => {
      throw new Error("no pair");
    },
  });
  expect(noPair.result.ok).toBe(false);
  if (noPair.result.ok) return;
  expect(noPair.result.error.status).toBe(503);
});

// Catches: a zero-copy frame escaping the 64KiB ceiling for a replaced draft.
test("a replaced draft over the byte ceiling is chunked", () => {
  const socket = fakeSocket();
  const connection = new LiveConnection(socket, CONVERSATION.id, { now: () => 0 });
  const fake = fakeSession();
  connection.start(fake.initial());
  connection.advance(view([], "a"));
  connection.advance(view([], "z".repeat(70_000)));
  const deltas = frames(socket).filter((frame) => frame.type === "delta");
  expect(deltas.length).toBeGreaterThan(1);
  for (const delta of deltas) {
    if (delta.type !== "delta") continue;
    expect(new TextEncoder().encode(delta.text).length).toBeLessThanOrEqual(64 * 1024);
  }
  expect(deltas[0]).toMatchObject({ replace: true });
});
