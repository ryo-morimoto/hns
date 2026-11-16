import { expect, test } from "vitest";
import {
  applyLiveFrame,
  explainConnection,
  initialLiveState,
  type LiveConversationState,
} from "./state.ts";

const entry = (id: string, kind = "pi.user", text = "hi") => ({ id, kind, text });

test("a snapshot is authoritative and sorts entries by id", () => {
  const next = applyLiveFrame(initialLiveState(), {
    type: "snapshot",
    protocol: 1,
    cursor: "2",
    conversationId: "2",
    title: "Live",
    entries: [entry("2"), entry("1")],
    draft: "part",
  });
  expect(next.status).toBe("online");
  expect(next.entries.map((item) => item.id)).toStrictEqual(["1", "2"]);
  expect(next.cursor).toBe("2");
  expect(next.draft).toBe("part");
});

// Catches: a duplicated append duplicating a transcript entry, or a reconnect snapshot leaving
// stale entries from before the disconnect.
test("appends merge by id while a snapshot replaces the window", () => {
  const base: LiveConversationState = {
    ...initialLiveState(),
    status: "online",
    entries: [entry("1")],
    cursor: "1",
  };
  const appended = applyLiveFrame(base, {
    type: "append",
    protocol: 1,
    cursor: "2",
    conversationId: "2",
    entries: [entry("1"), entry("2", "pi.assistant", "answer")],
  });
  expect(appended.entries.map((item) => item.id)).toStrictEqual(["1", "2"]);
  expect(appended.cursor).toBe("2");

  const replaced = applyLiveFrame(appended, {
    type: "snapshot",
    protocol: 1,
    cursor: "9",
    conversationId: "2",
    title: "Live",
    entries: [entry("9")],
    draft: "",
  });
  expect(replaced.entries.map((item) => item.id)).toStrictEqual(["9"]);
});

test("deltas append unless replace says otherwise", () => {
  const first = applyLiveFrame(initialLiveState(), {
    type: "delta",
    protocol: 1,
    conversationId: "2",
    text: "hel",
    replace: false,
  });
  expect(first.draft).toBe("hel");
  const second = applyLiveFrame(first, {
    type: "delta",
    protocol: 1,
    conversationId: "2",
    text: "lo",
    replace: false,
  });
  expect(second.draft).toBe("hello");
  const replaced = applyLiveFrame(second, {
    type: "delta",
    protocol: 1,
    conversationId: "2",
    text: "new",
    replace: true,
  });
  expect(replaced.draft).toBe("new");
});

test("a typed error is surfaced without dropping the transcript", () => {
  const base: LiveConversationState = {
    ...initialLiveState(),
    status: "online",
    entries: [entry("1")],
  };
  const next = applyLiveFrame(base, {
    type: "error",
    protocol: 1,
    code: "invalid_request",
    message: "bad frame",
  });
  expect(next.status).toBe("online");
  expect(next.entries).toHaveLength(1);
  expect(next.error).toBe("bad frame");
});

// Catches: an offline screen that does not say what the user can do about it.
test("the explanation names the attempt and the action", () => {
  const reconnecting = explainConnection({
    ...initialLiveState(),
    status: "reconnecting",
    attempt: 3,
  });
  expect(reconnecting.label).toBe("再接続中");
  expect(reconnecting.detail).toMatch(/3回目/u);

  const offline = explainConnection({ ...initialLiveState(), status: "offline" });
  expect(offline.label).toBe("未接続");
  expect(offline.detail).toMatch(/再読み込み/u);
});
