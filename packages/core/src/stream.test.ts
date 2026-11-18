import * as v from "valibot";
import { expect, test } from "vitest";
import {
  chunkLiveText,
  EMPTY_LIVE_CURSOR,
  LIVE_DELTA_INTERVAL_MS,
  LIVE_DELTA_MAX_BYTES,
  LIVE_SEND_MAX_BYTES,
  LiveDeltaBatcher,
  LiveFrameSchema,
  liveCursorOf,
  liveCursorValue,
  parseLiveClientMessage,
  parseLiveFrame,
  sendResultOf,
  type LiveEntry,
} from "./stream.ts";

const entry: LiveEntry = { id: "7", kind: "pi.assistant", text: "hello" };

test("every live frame kind parses and unknown kinds are refused", () => {
  const frames = [
    {
      type: "snapshot",
      protocol: 1,
      cursor: "7",
      conversationId: "3",
      title: "Talk",
      entries: [entry],
      draft: "",
    },
    { type: "append", protocol: 1, cursor: "8", conversationId: "3", entries: [entry] },
    { type: "delta", protocol: 1, conversationId: "3", text: "hel", replace: false },
    { type: "pong", protocol: 1 },
    { type: "error", protocol: 1, code: "not_found", message: "gone" },
  ] as const;
  for (const frame of frames) {
    expect(parseLiveFrame(frame)).toStrictEqual(frame);
  }

  expect(() => parseLiveFrame({ type: "mystery", protocol: 1 })).toThrow(v.ValiError);
  expect(() => parseLiveFrame({ type: "pong", protocol: 2 })).toThrow(v.ValiError);
});

// Catches: an entry id of 0 being treated as a durable entry rather than the empty cursor.
test("entry ids are positive while the empty cursor is zero", () => {
  const snapshot = {
    type: "snapshot",
    protocol: 1,
    cursor: "1",
    conversationId: "2",
    title: "Live",
    entries: [{ id: "0", kind: "pi.user", text: "hi" }],
    draft: "",
  };
  expect(() => parseLiveFrame(snapshot)).toThrow(v.ValiError);
});

// Catches: a frame from another protocol version being applied as if it were this one.
test("a frame of another protocol is refused", () => {
  expect(v.safeParse(LiveFrameSchema, { type: "pong", protocol: 2 }).success).toBe(false);
});

test("client messages are a closed union", () => {
  expect(parseLiveClientMessage({ type: "ping" })).toStrictEqual({ type: "ping" });
  expect(parseLiveClientMessage({ type: "resync" })).toStrictEqual({ type: "resync" });
  expect(() => parseLiveClientMessage({ type: "subscribe" })).toThrow(v.ValiError);
});

test("a send carries its conversation, its client id, and its text", () => {
  const send = {
    type: "send",
    conversationId: "7",
    clientMessageId: "6f1c",
    text: "hi",
  } as const;
  expect(parseLiveClientMessage(send)).toStrictEqual(send);
  expect(parseLiveClientMessage({ type: "abort", conversationId: "7" })).toStrictEqual({
    type: "abort",
    conversationId: "7",
  });
});

// Catches: an empty send, a send with no client id, or a send whose conversation is unnamed
// reaching the object as a turn it can neither deduplicate nor address.
test("a send without a conversation, client id, or text is refused", () => {
  const base = { type: "send", conversationId: "7", clientMessageId: "id", text: "hi" } as const;
  for (const missing of ["conversationId", "clientMessageId", "text"] as const) {
    const { [missing]: _dropped, ...rest } = base;
    expect(() => parseLiveClientMessage(rest)).toThrow(v.ValiError);
  }
  expect(() => parseLiveClientMessage({ ...base, text: "" })).toThrow(v.ValiError);
  expect(() => parseLiveClientMessage({ ...base, clientMessageId: "" })).toThrow(v.ValiError);
});

// Catches: a text measured in characters instead of bytes, so a 64Ki-character Japanese turn
// (three bytes each) passes the schema and the object is handed a body it refuses later.
test("the send text is bounded in UTF-8 bytes", () => {
  const send = (text: string) => ({
    type: "send",
    conversationId: "7",
    clientMessageId: "id",
    text,
  });
  expect(parseLiveClientMessage(send("a".repeat(LIVE_SEND_MAX_BYTES)))).toBeTruthy();
  expect(() => parseLiveClientMessage(send("a".repeat(LIVE_SEND_MAX_BYTES + 1)))).toThrow(
    v.ValiError,
  );
  // 21846 code points of 3 bytes are exactly 65538 bytes: one past the ceiling.
  expect(() => parseLiveClientMessage(send("あ".repeat(21_846)))).toThrow(v.ValiError);
  expect(parseLiveClientMessage(send("あ".repeat(21_845)))["type"]).toBe("send");
});

// Catches: a view frame coming from the client, or an answer being parsed as a view frame.
test("views and send answers are different unions", () => {
  expect(() => parseLiveFrame({ type: "accepted", clientMessageId: "a", messageId: "1" })).toThrow(
    v.ValiError,
  );
  expect(() => parseLiveClientMessage({ type: "snapshot", protocol: 1 })).toThrow(v.ValiError);
});

// Catches: a view frame being taken for an answer (or an answer for a view frame) on the one
// socket that carries both, and a malformed answer being read as a refusal of every send.
test("a send answer is recognised by the schema, not by its reader", () => {
  const accepted = { type: "accepted", clientMessageId: "a", messageId: "3" } as const;
  const rejected = {
    type: "rejected",
    clientMessageId: "b",
    code: "invalid_text",
    message: "empty",
  } as const;
  expect(sendResultOf(accepted)).toStrictEqual(accepted);
  expect(sendResultOf(rejected)).toStrictEqual(rejected);
  expect(sendResultOf({ ...accepted, clientMessageId: "" })).toBeNull();
  expect(sendResultOf({ ...rejected, code: "mystery" })).toBeNull();
  expect(sendResultOf({ type: "snapshot", protocol: 1 })).toBeNull();
  expect(sendResultOf("accepted")).toBeNull();
  expect(sendResultOf(null)).toBeNull();
});

test("cursors are decimal entry ids", () => {
  expect(liveCursorValue(EMPTY_LIVE_CURSOR)).toBe(0);
  expect(liveCursorValue("42")).toBe(42);
  expect(() => liveCursorValue("01")).toThrow();
  expect(() => liveCursorValue("x")).toThrow();
  expect(liveCursorOf([{ id: "3" }, { id: "9" }, { id: "5" }])).toBe("9");
  expect(liveCursorOf([])).toBe(EMPTY_LIVE_CURSOR);
});

// Catches: a token burst producing one frame per token, or a frame larger than the wire budget.
test("token deltas fold into at most one frame per interval", () => {
  const batcher = new LiveDeltaBatcher();
  const frames: string[] = [];
  let at = 0;
  for (let index = 0; index < 100; index += 1) {
    at = index * 10;
    frames.push(...batcher.push("x", at));
  }
  frames.push(...batcher.flush(at));
  expect(frames.length).toBeLessThanOrEqual(11);
  expect(frames.join("")).toBe("x".repeat(100));
});

// Catches: a large answer sent as one frame, or a chunk boundary splitting a surrogate pair.
test("a large batch is split at the byte ceiling without dropping text", () => {
  const batcher = new LiveDeltaBatcher({ intervalMs: 100, maxBytes: 64 });
  const text = "🙂".repeat(100) + "z".repeat(100);
  const frames = [...batcher.push(text, 0), ...batcher.flush(0)];
  expect(frames.length).toBeGreaterThan(1);
  for (const frame of frames) {
    expect(new TextEncoder().encode(frame).length).toBeLessThanOrEqual(64);
  }
  expect(frames.join("")).toBe(text);
});

// Catches: a batcher that waits forever when the source stops emitting.
test("flush releases pending text before the interval elapses", () => {
  const batcher = new LiveDeltaBatcher();
  expect(batcher.push("he", 0)).toStrictEqual([]);
  expect(batcher.pending).toBe("he");
  expect(batcher.delayUntil(0)).toBe(LIVE_DELTA_INTERVAL_MS);
  expect(batcher.flush(10)).toStrictEqual(["he"]);
  expect(batcher.pending).toBe("");
});

test("reset drops text a replacement supersedes", () => {
  const batcher = new LiveDeltaBatcher();
  batcher.push("old", 0);
  batcher.reset();
  expect(batcher.pending).toBe("");
  expect(batcher.push("new", 200)).toStrictEqual([]);
  expect(batcher.flush(200)).toStrictEqual(["new"]);
});

test("chunking keeps code points whole", () => {
  expect(chunkLiveText("", 8)).toStrictEqual([]);
  expect(chunkLiveText("🙂🙂", 4)).toStrictEqual(["🙂", "🙂"]);
  expect(() => chunkLiveText("x", 0)).toThrow(RangeError);
});

test("the default limits match the issue budget", () => {
  expect(LIVE_DELTA_INTERVAL_MS).toBe(100);
  expect(LIVE_DELTA_MAX_BYTES).toBe(64 * 1024);
});
