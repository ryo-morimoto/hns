import { LIVE_SEND_MAX_BYTES, type LiveSendRejectionCode, type LiveSendResult } from "@hns/core";
import { afterEach, expect, test, vi } from "vitest";
import {
  CONVERSATION,
  fakeHost,
  fakeSession,
  fakeSocket,
  parseFrames,
  testUpgradeResponse,
  type FakeSocket,
} from "../test/support/live.ts";
import { refusalOf } from "./do/session.ts";
import { LiveConnection, openLiveSocket, type LiveSendPort } from "./ws.ts";

afterEach(() => {
  vi.useRealTimers();
});

/** One send the port was asked to make. */
interface RecordedSend {
  readonly conversationId: string;
  readonly text: string;
  readonly clientMessageId: string;
}

/**
 * A chat port over the real connection, recording what it was asked.
 *
 * @remarks
 * The port is the one seam a socket test needs: everything from the text frame through the
 * frame parser, the connection's pending bookkeeping, and the answer frame is the production
 * code. The port stands in for the object's own RPC, which its tests exercise directly.
 */
function port(
  overrides: {
    readonly send?: (
      send: RecordedSend,
    ) => Promise<
      | { readonly ok: true; readonly messageId: string }
      | { readonly ok: false; readonly code: LiveSendRejectionCode; readonly message: string }
    >;
    readonly abort?: (
      conversationId: string,
    ) => Promise<
      | { readonly ok: true }
      | { readonly ok: false; readonly code: LiveSendRejectionCode; readonly message: string }
    >;
  } = {},
) {
  const sends: RecordedSend[] = [];
  const aborts: string[] = [];
  const chat: LiveSendPort = {
    send: async (conversationId, text, clientMessageId) => {
      const send = { conversationId, text, clientMessageId };
      sends.push(send);
      if (overrides.send !== undefined) return await overrides.send(send);
      return { ok: true, messageId: "9" };
    },
    abort: async (conversationId) => {
      aborts.push(conversationId);
      if (overrides.abort !== undefined) return await overrides.abort(conversationId);
      return { ok: true };
    },
  };
  return { chat, sends, aborts };
}

/** Upgrade a socket against the fake session and the given chat port. */
async function open(chat: LiveSendPort | undefined, id: string = CONVERSATION.id) {
  const server = fakeSocket();
  const client = fakeSocket();
  const result = await openLiveSocket({
    request: new Request("https://session/ws?conversationId=" + id, {
      headers: { upgrade: "websocket" },
    }),
    host: fakeHost(),
    pair: () => ({ 0: client, 1: server }),
    session: fakeSession().session,
    chat,
    now: () => 0,
    upgradeResponse: testUpgradeResponse,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("the upgrade failed: " + String(result.error.status));
  return { connection: result.value.connection, server };
}

/** The answers a socket received, parsed as send answers. */
function answersOf(socket: FakeSocket): LiveSendResult[] {
  return parseFrames(socket).flatMap((frame) =>
    frame.type === "accepted" || frame.type === "rejected" ? [frame] : [],
  );
}

// Catches: a send frame the server accepts but never answers, which leaves every composer
// waiting on a turn it cannot know began.
test("a send frame is answered accepted with the conversation's input id", async () => {
  const chat = port();
  const { connection, server } = await open(chat.chat);

  connection.handleMessage(
    JSON.stringify({
      type: "send",
      conversationId: CONVERSATION.id,
      clientMessageId: "c1",
      text: "hi",
    }),
  );
  await vi.waitFor(() => {
    expect(answersOf(server)).toHaveLength(1);
  });

  expect(chat.sends).toStrictEqual([
    { conversationId: CONVERSATION.id, text: "hi", clientMessageId: "c1" },
  ]);
  expect(answersOf(server)[0]).toStrictEqual({
    type: "accepted",
    clientMessageId: "c1",
    messageId: "9",
  });
});

// Catches: a refused turn reported as accepted, so the composer clears text that never ran.
test("a refused send is answered rejected with its code", async () => {
  const chat = port({
    send: async () => ({ ok: false, code: "unknown_conversation", message: "gone" }),
  });
  const { connection, server } = await open(chat.chat);

  connection.handleMessage(
    JSON.stringify({
      type: "send",
      conversationId: CONVERSATION.id,
      clientMessageId: "c1",
      text: "hi",
    }),
  );
  await vi.waitFor(() => {
    expect(answersOf(server)).toHaveLength(1);
  });

  expect(answersOf(server)[0]).toStrictEqual({
    type: "rejected",
    clientMessageId: "c1",
    code: "unknown_conversation",
    message: "gone",
  });
});

// Catches: a port that throws leaving the send unanswered forever, instead of a typed refusal
// the client can show.
test("a send whose port failed is answered unavailable", async () => {
  const chat = port({
    send: async () => {
      throw new Error("rpc died");
    },
  });
  const { connection, server } = await open(chat.chat);

  connection.handleMessage(
    JSON.stringify({
      type: "send",
      conversationId: CONVERSATION.id,
      clientMessageId: "c1",
      text: "hi",
    }),
  );
  await vi.waitFor(() => {
    expect(answersOf(server)).toHaveLength(1);
  });

  expect(answersOf(server)[0]).toMatchObject({ type: "rejected", code: "unavailable" });
});

// Catches: the same client id reaching the object twice on one connection, which is the one
// place the socket can still make a duplicate turn.
test("a resend of a pending client id waits on the first, and runs nothing twice", async () => {
  let finish: (() => void) | undefined;
  const chat = port({
    send: async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { ok: true, messageId: "7" };
    },
  });
  const { connection, server } = await open(chat.chat);
  const frame = JSON.stringify({
    type: "send",
    conversationId: CONVERSATION.id,
    clientMessageId: "same",
    text: "hi",
  });

  connection.handleMessage(frame);
  connection.handleMessage(frame);
  expect(chat.sends).toHaveLength(1);

  finish?.();
  await vi.waitFor(() => {
    expect(answersOf(server)).toHaveLength(1);
  });
  // The second send is the same turn, so it is answered by the first one's answer, once.
  expect(answersOf(server)[0]).toMatchObject({ type: "accepted", clientMessageId: "same" });
});

// Catches: an abort frame that never reaches the object, leaving a run nobody can stop.
test("an abort frame is passed to the object and answered by the view, not a frame", async () => {
  const chat = port();
  const { connection, server } = await open(chat.chat);

  connection.handleMessage(JSON.stringify({ type: "abort", conversationId: CONVERSATION.id }));
  await vi.waitFor(() => {
    expect(chat.aborts).toStrictEqual([CONVERSATION.id]);
  });
  // An abort changes the conversation, so the change arrives as the view; the connection adds
  // no frame of its own.
  expect(answersOf(server)).toStrictEqual([]);
  const kinds: string[] = [];
  for (const frame of parseFrames(server)) {
    if (frame.type !== "accepted" && frame.type !== "rejected") kinds.push(frame.type);
  }
  expect(kinds).toStrictEqual(["snapshot"]);
});

// Catches: a refused abort staying silent, which leaves the person pressing a button that did
// nothing.
test("a refused abort is a typed error frame", async () => {
  const chat = port({
    abort: async () => ({ ok: false, code: "unknown_conversation", message: "gone" }),
  });
  const { connection, server } = await open(chat.chat);

  connection.handleMessage(JSON.stringify({ type: "abort", conversationId: CONVERSATION.id }));
  await vi.waitFor(() => {
    const last = server.sent.at(-1) ?? "";
    expect(JSON.parse(last)).toMatchObject({ type: "error", code: "not_found" });
  });
});

// Catches: a connection without the chat (a Session opened without its RPC) silently dropping
// the client's command.
test("a send with no chat port is answered unavailable", async () => {
  const { connection, server } = await open(undefined);

  connection.handleMessage(
    JSON.stringify({
      type: "send",
      conversationId: CONVERSATION.id,
      clientMessageId: "c1",
      text: "hi",
    }),
  );
  await vi.waitFor(() => {
    expect(answersOf(server)).toHaveLength(1);
  });
  expect(answersOf(server)[0]).toMatchObject({ type: "rejected", code: "unavailable" });
});

// Catches: the object's 404 for a conversation it does not hold reaching the client as a
// transient failure (which a person would retry forever) instead of `unknown_conversation`. The
// port here is the production refusal: the test drives the object's status through
// `refusalOf` rather than spelling the client's code itself.
test("a send for an unknown conversation is rejected without a turn", async () => {
  const asked: string[] = [];
  const chat = port({
    send: async (send) => {
      asked.push(send.conversationId);
      // The object answered the turn route `404`: no conversation has this id.
      return refusalOf("The turn could not be started.", 404);
    },
  });
  const { connection, server } = await open(chat.chat);

  connection.handleMessage(
    JSON.stringify({
      type: "send",
      conversationId: "999",
      clientMessageId: "c1",
      text: "hi",
    }),
  );
  await vi.waitFor(() => {
    expect(answersOf(server)).toHaveLength(1);
  });

  expect(asked).toStrictEqual(["999"]);
  expect(answersOf(server)[0]).toMatchObject({
    type: "rejected",
    clientMessageId: "c1",
    code: "unknown_conversation",
  });
});

// Catches: an empty send reaching the object, where it would be a turn with nothing to run.
test("an empty send is refused on the connection, and the object is never asked", async () => {
  const chat = port();
  const { connection, server } = await open(chat.chat);

  connection.handleMessage(
    JSON.stringify({
      type: "send",
      conversationId: CONVERSATION.id,
      clientMessageId: "c1",
      text: "",
    }),
  );

  expect(JSON.parse(server.sent.at(-1) ?? "")).toMatchObject({
    type: "error",
    code: "invalid_request",
  });
  expect(chat.sends).toStrictEqual([]);
  expect(answersOf(server)).toStrictEqual([]);
});

// Catches: a text over the 64KiB wire limit reaching the object, which could only refuse it
// after the send was already answered as something else.
test("a send over 64KiB is refused on the connection, and the object is never asked", async () => {
  const chat = port();
  const { connection, server } = await open(chat.chat);
  const text = "a".repeat(LIVE_SEND_MAX_BYTES + 1);

  connection.handleMessage(
    JSON.stringify({ type: "send", conversationId: CONVERSATION.id, clientMessageId: "c1", text }),
  );

  expect(JSON.parse(server.sent.at(-1) ?? "")).toMatchObject({
    type: "error",
    code: "invalid_request",
  });
  expect(chat.sends).toStrictEqual([]);
  expect(answersOf(server)).toStrictEqual([]);
});

// Catches: a malformed send (no text, no client id) reaching the object, where it would be a
// turn with nothing to run and nothing to deduplicate.
test("a malformed send is an invalid_request error and reaches no turn", async () => {
  const chat = port();
  const { connection, server } = await open(chat.chat);

  connection.handleMessage(
    JSON.stringify({ type: "send", conversationId: CONVERSATION.id, clientMessageId: "c1" }),
  );
  expect(JSON.parse(server.sent.at(-1) ?? "")).toMatchObject({
    type: "error",
    code: "invalid_request",
  });
  expect(chat.sends).toStrictEqual([]);
});

// Catches: a turn running and a stop arriving while nothing tracks the in-flight send, so a
// close lets the answer be decided after the socket is gone without anyone noticing.
test("a close keeps the in-flight send in the connection's pending set", async () => {
  const chat = port({
    send: async () => new Promise(() => undefined),
  });
  const connection = new LiveConnection(fakeSocket(), CONVERSATION.id, { chat: chat.chat });
  connection.handleMessage(
    JSON.stringify({
      type: "send",
      conversationId: CONVERSATION.id,
      clientMessageId: "c1",
      text: "hi",
    }),
  );
  expect(connection.pending).toHaveLength(1);
});
