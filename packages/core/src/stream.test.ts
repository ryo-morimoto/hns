import * as v from "valibot";
import { expect, test } from "vitest";
import {
  chunkLiveText,
  EMPTY_LIVE_CURSOR,
  LIVE_DELTA_INTERVAL_MS,
  LIVE_DELTA_MAX_BYTES,
  LiveDeltaBatcher,
  LiveFrameSchema,
  liveCursorOf,
  liveCursorValue,
  parseLiveClientMessage,
  parseLiveFrame,
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
