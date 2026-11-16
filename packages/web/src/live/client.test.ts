import { expect, test } from "vitest";
import { createLiveClient, LIVE_RECONNECT_DELAYS_MS } from "./client.ts";
import { snapshotFrame, socketFactory } from "../../test/live/support.ts";

interface Scheduled {
  readonly run: () => void;
  readonly ms: number;
}

function clientWithQueue() {
  const { factory, sockets } = socketFactory();
  const scheduled: Scheduled[] = [];
  const client = createLiveClient({
    conversationId: "2",
    socket: factory,
    schedule: (run, ms) => {
      scheduled.push({ run, ms });
      return () => undefined;
    },
  });
  return { client, sockets, scheduled };
}

test("the client opens the conversation and applies the snapshot", () => {
  const { client, sockets } = clientWithQueue();
  expect(client.state.status).toBe("connecting");
  expect(sockets[0]?.url).toBe("/ws?conversationId=2");
  sockets[0]?.open();
  expect(client.state.status).toBe("online");
  sockets[0]?.message(snapshotFrame("5", [{ id: "5", kind: "pi.user", text: "hi" }]));
  expect(client.state.cursor).toBe("5");
  expect(client.state.entries.map((entry) => entry.id)).toStrictEqual(["5"]);
});

// Catches: a reconnect that starts from zero and loses the entries committed while away.
test("a reconnect carries the cursor and applies the replacement snapshot", () => {
  const { client, sockets, scheduled } = clientWithQueue();
  sockets[0]?.open();
  sockets[0]?.message(snapshotFrame("5", [{ id: "5", kind: "pi.user", text: "hi" }]));
  sockets[0]?.drop();
  expect(client.state.status).toBe("reconnecting");
  expect(client.state.attempt).toBe(1);
  expect(scheduled[0]?.ms).toBe(LIVE_RECONNECT_DELAYS_MS[0]);

  scheduled[0]?.run();
  expect(sockets[1]?.url).toBe("/ws?conversationId=2&cursor=5");
  sockets[1]?.open();
  sockets[1]?.message(
    snapshotFrame("6", [
      { id: "5", kind: "pi.user", text: "hi" },
      { id: "6", kind: "pi.assistant", text: "hello" },
    ]),
  );
  expect(client.state.status).toBe("online");
  expect(client.state.cursor).toBe("6");
  expect(client.state.entries.map((entry) => entry.id)).toStrictEqual(["5", "6"]);
});

// Catches: reconnecting forever without telling the user the stream stopped.
test("after the delay budget the client reports offline", () => {
  const { client, sockets, scheduled } = clientWithQueue();
  for (let attempt = 0; attempt < LIVE_RECONNECT_DELAYS_MS.length; attempt += 1) {
    sockets.at(-1)?.drop();
    const job = scheduled.shift();
    expect(job?.ms).toBe(LIVE_RECONNECT_DELAYS_MS[attempt]);
    job?.run();
  }
  sockets.at(-1)?.drop();
  expect(client.state.status).toBe("offline");
  expect(client.state.error).toMatch(/再読み込み/u);
});

test("a malformed frame is surfaced and the connection stays usable", () => {
  const { client, sockets } = clientWithQueue();
  sockets[0]?.open();
  sockets[0]?.message({ type: "mystery" });
  expect(client.state.status).toBe("online");
  expect(client.state.error).toMatch(/不正/u);
  sockets[0]?.message(snapshotFrame("1"));
  expect(client.state.error).toBeNull();
  expect(client.state.cursor).toBe("1");
});

test("closing the client stops reconnecting", () => {
  const { client, sockets, scheduled } = clientWithQueue();
  sockets[0]?.open();
  sockets[0]?.drop();
  expect(scheduled).toHaveLength(1);
  client.close();
  scheduled[0]?.run();
  expect(sockets).toHaveLength(1);
});

test("retry clears the attempt count and opens a fresh socket", () => {
  const { client, sockets } = clientWithQueue();
  sockets[0]?.open();
  sockets[0]?.drop();
  expect(client.state.attempt).toBe(1);
  client.retry();
  expect(client.state.attempt).toBe(0);
  expect(sockets).toHaveLength(2);
});

// Catches: a stale close from the replaced socket scheduling a second reconnect.
test("retry does not let the replaced socket schedule another reconnect", () => {
  const { client, sockets, scheduled } = clientWithQueue();
  sockets[0]?.open();
  client.retry();
  expect(sockets).toHaveLength(2);
  expect(scheduled).toHaveLength(0);
  sockets[0]?.drop();
  expect(scheduled).toHaveLength(0);
  expect(client.state.status).toBe("connecting");
});
