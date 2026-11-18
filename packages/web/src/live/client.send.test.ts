import { expect, test } from "vitest";
import { parseLiveClientMessage, type LiveClientMessage, type LiveSendResult } from "@hns/core";
import { createLiveClient } from "./client.ts";
import { snapshotFrame, socketFactory } from "../../test/live/support.ts";

interface Scheduled {
  readonly run: () => void;
  readonly ms: number;
}

/** A client whose reconnects are a queue the test runs, and whose sockets the test drives. */
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

/** The frames a socket received, parsed by the protocol (sends and aborts are both here). */
function framesOf(socket: { readonly sent: readonly string[] }): LiveClientMessage[] {
  return socket.sent.map((text) => {
    const value: unknown = JSON.parse(text);
    return parseLiveClientMessage(value);
  });
}

/** The sends one socket received. */
function sendsOf(socket: { readonly sent: readonly string[] }): LiveClientMessage[] {
  return framesOf(socket).filter((frame) => frame.type === "send");
}

// Catches: a send written before the socket is up (and lost by the socket), or a send that
// claims to have gone out when it did not.
test("a send before the connection is open says disconnected and goes out on open", () => {
  const { client, sockets } = clientWithQueue();
  expect(client.send("m1", "hello")).toBe("disconnected");
  expect(sendsOf(sockets[0]!)).toHaveLength(0);

  sockets[0]?.open();
  const sends = sendsOf(sockets[0]!);
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({
    type: "send",
    conversationId: "2",
    clientMessageId: "m1",
    text: "hello",
  });
});

// Catches: the same client id being written twice on one connection, which the object would
// run or refuse as two turns instead of one.
test("the same client id is not written twice", () => {
  const { client, sockets } = clientWithQueue();
  sockets[0]?.open();
  expect(client.send("m1", "hello")).toBeNull();
  expect(client.send("m1", "hello again")).toBeNull();
  expect(sendsOf(sockets[0]!)).toHaveLength(1);
  expect(sendsOf(sockets[0]!)[0]).toMatchObject({ type: "send", text: "hello" });
});

// Catches: a send made just before a drop being lost with the connection.
test("an unanswered send is written again when the connection is restored", () => {
  const { client, sockets, scheduled } = clientWithQueue();
  sockets[0]?.open();
  client.send("m1", "hello");
  sockets[0]?.drop();
  scheduled[0]?.run();
  sockets[1]?.open();

  expect(sendsOf(sockets[1]!)).toHaveLength(1);
  expect(sendsOf(sockets[1]!)[0]).toMatchObject({ clientMessageId: "m1" });
});

// Catches: an answered send being written again after a reconnect, which would be a second run.
test("an answered send is not written again", () => {
  const { client, sockets, scheduled } = clientWithQueue();
  const results: LiveSendResult[] = [];
  client.onSendResult((result) => {
    results.push(result);
  });
  sockets[0]?.open();
  client.send("m1", "hello");
  sockets[0]?.message({ type: "accepted", clientMessageId: "m1", messageId: "7" });
  expect(results).toStrictEqual([{ type: "accepted", clientMessageId: "m1", messageId: "7" }]);

  sockets[0]?.drop();
  scheduled[0]?.run();
  sockets[1]?.open();
  expect(sendsOf(sockets[1]!)).toHaveLength(0);
});

// Catches: an answer to a send this client never made being reported as one of its own (an
// answer on a shared connection for another tab's send).
test("an answer to a send this client did not make is not reported", () => {
  const { client, sockets } = clientWithQueue();
  const results: LiveSendResult[] = [];
  client.onSendResult((result) => {
    results.push(result);
  });
  sockets[0]?.open();
  sockets[0]?.message({
    type: "rejected",
    clientMessageId: "other",
    code: "invalid_text",
    message: "x",
  });
  expect(results).toStrictEqual([]);
  // The answer is not a view frame either: no error is recorded for it.
  expect(client.state.error).toBeNull();
});

// Catches: a view frame being mistaken for an answer, which would silently stop updating the
// transcript.
test("a view frame is still applied while sends are outstanding", () => {
  const { client, sockets } = clientWithQueue();
  sockets[0]?.open();
  client.send("m1", "hello");
  sockets[0]?.message(snapshotFrame("3", [{ id: "3", kind: "pi.user", text: "hello" }]));
  expect(client.state.entries.map((entry) => entry.id)).toStrictEqual(["3"]);
  expect(client.state.error).toBeNull();
});

// Catches: an abandoned send going out behind the person's back after they were told it failed.
test("an abandoned send is not written on the next connection", () => {
  const { client, sockets, scheduled } = clientWithQueue();
  sockets[0]?.open();
  client.send("m1", "hello");
  client.abandonSend("m1");
  sockets[0]?.drop();
  scheduled[0]?.run();
  sockets[1]?.open();
  expect(sendsOf(sockets[1]!)).toHaveLength(0);
});

// Catches: a stop that never reaches the server, or one sent while there is no connection.
test("an abort is written only while the connection is up", () => {
  const { client, sockets } = clientWithQueue();
  expect(client.abort()).toBe(false);
  sockets[0]?.open();
  expect(client.abort()).toBe(true);
  expect(framesOf(sockets[0]!)).toStrictEqual([{ type: "abort", conversationId: "2" }]);
});

// Catches: a client that keeps queueing sends after it gave up reconnecting, leaving the
// composer waiting on a send that can never go out.
test("a send after the client gave up is refused as offline", () => {
  const { client, sockets, scheduled } = clientWithQueue();
  sockets[0]?.open();
  for (let attempt = 0; attempt <= 5; attempt += 1) {
    sockets.at(-1)?.drop();
    scheduled.at(-1)?.run();
  }
  expect(client.state.status).toBe("offline");
  expect(client.send("m1", "hello")).toBe("offline");
});
