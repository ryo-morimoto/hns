/* oxlint-disable anti-slop/no-runtime-typeof -- the platform's fetch input is a Request, a URL,
   or a URL string; the fake fetch records which one it was given.
*/
import {
  ConversationIdSchema,
  ProjectIdSchema,
  type Conversation,
  type JsonValue,
} from "@hns/core";
import * as v from "valibot";
import { expect, test } from "vitest";
import {
  ABORTED_ASSISTANT_KIND,
  conversationStateOf,
  isInterrupted,
  itemKindOf,
  latestTurn,
  mergeEntries,
  progressOf,
  readConversationState,
  sortEntries,
  transcriptOf,
  type LiveEntryLike,
} from "./transcript.ts";

const ENTRY = (id: string, kind: string, text: string): LiveEntryLike => ({ id, kind, text });

const CONVERSATION: Conversation = {
  id: v.parse(ConversationIdSchema, "conversation-intent"),
  project_id: v.parse(ProjectIdSchema, "project-hns"),
  title: "Web の土台",
  created_at: "2026-11-07T00:00:00.000Z",
  updated_at: null,
  archived: false,
  deleted_at: null,
};

// Catches: an entry kind reaching the screen's items, so a page would print `pi.*` or have to
// branch on a store value it does not know.
test("every entry kind becomes one of the screen's own kinds", () => {
  expect(itemKindOf("pi.user")).toStrictEqual({ kind: "user" });
  expect(itemKindOf("pi.assistant")).toStrictEqual({ kind: "assistant" });
  expect(itemKindOf("pi.tool-result")).toStrictEqual({ kind: "tool" });
  // An unknown kind is shown as text, never as a kind.
  expect(itemKindOf("pi.reset").kind).toBe("system");
  expect(itemKindOf("something.new").kind).toBe("system");
});

// Catches: entries drawn in arrival order, so a snapshot and an append disagree about a turn.
test("entries are ordered by id, not by arrival", () => {
  const items = transcriptOf([
    ENTRY("10", "pi.assistant", "second"),
    ENTRY("2", "pi.user", "first"),
  ]);
  expect(items.map((item) => item.text)).toStrictEqual(["first", "second"]);
  const byId = [
    ENTRY("9", "pi.user", "nine"),
    ENTRY("10", "pi.user", "ten"),
    ENTRY("1", "pi.user", "one"),
  ];
  expect(sortEntries(byId).map((entry) => entry.id)).toStrictEqual(["1", "9", "10"]);
});

// Catches: the read and the socket both delivering an entry and the screen drawing it twice.
test("the same entry from the read and the socket appears once", () => {
  const merged = mergeEntries(
    [ENTRY("1", "pi.user", "from the read"), ENTRY("2", "pi.assistant", "read")],
    [ENTRY("3", "pi.user", "socket"), ENTRY("2", "pi.assistant", "socket")],
  );
  expect(merged.map((entry) => entry.id)).toStrictEqual(["1", "2", "3"]);
  // The socket's copy wins: it is the one the server just confirmed, not a response in flight.
  expect(merged[1]?.text).toBe("socket");
});

// Catches: a stopped run reading as a finished one, or a run after a stop still reading as
// stopped because an old aborted entry is somewhere in the transcript.
test("only the newest entry says whether the run was stopped", () => {
  const stopped = [ENTRY("1", "pi.user", "go"), ENTRY("2", ABORTED_ASSISTANT_KIND, "half")];
  expect(isInterrupted(stopped)).toBe(true);
  expect(isInterrupted([...stopped, ENTRY("3", "pi.user", "again")])).toBe(false);
  expect(isInterrupted([...stopped, ENTRY("3", "pi.assistant", "done")])).toBe(false);
  expect(isInterrupted([ENTRY("1", "pi.user", "go")])).toBe(false);
  expect(isInterrupted([])).toBe(false);
  // An empty assistant entry says nothing about how the run ended.
  expect(isInterrupted([ENTRY("1", "pi.assistant", ""), ENTRY("2", "pi.user", "go")])).toBe(false);
});

// Catches: the progress line saying "waiting" while the model is answering, or "thinking" while
// a tool is executing.
test("the progress line follows the newest turn, not the newest entry", () => {
  const idle = { kind: "idle" } as const;
  expect(progressOf([], "", idle)).toBeNull();
  expect(progressOf([ENTRY("1", "pi.user", "go")], "", idle)).toStrictEqual({
    kind: "waiting",
    label: "待ち",
    live: true,
  });
  // The turn's tool has returned and the model has not been asked for its next answer yet.
  expect(
    progressOf([ENTRY("1", "pi.user", "go"), ENTRY("2", "pi.tool-result", "ok")], "", idle)?.kind,
  ).toBe("tool");
  expect(progressOf([ENTRY("1", "pi.user", "go")], "半分", idle)?.kind).toBe("thinking");
  // An answered turn is quiet.
  expect(
    progressOf([ENTRY("1", "pi.user", "go"), ENTRY("2", "pi.assistant", "done")], "", idle),
  ).toBeNull();
  // A transcript that is only a tool result has no turn in it: nothing claims a tool is running.
  expect(progressOf([ENTRY("1", "pi.tool-result", "ok")], "", idle)).toBeNull();
});

// Catches: a tool result — which the server commits when the tool has *returned* — making the
// progress line say a tool is still executing, so a finished or stopped conversation looks busy.
test("a committed tool result from a settled turn is not a running tool", () => {
  const idle = { kind: "idle" } as const;
  const answered = [
    ENTRY("1", "pi.user", "go"),
    ENTRY("2", "pi.tool-result", "ok"),
    ENTRY("3", "pi.assistant", "done"),
  ];
  expect(progressOf(answered, "", idle)).toBeNull();
  const stopped = [
    ...answered,
    ENTRY("4", "pi.user", "again"),
    ENTRY("5", ABORTED_ASSISTANT_KIND, ""),
  ];
  expect(progressOf(stopped, "", idle)?.kind).toBe("stopped");
  // The tool call of a live turn is the newest thing the turn has: its result is still out.
  expect(latestTurn([ENTRY("1", "pi.user", "go")])).toStrictEqual({ state: "waiting" });
  expect(
    latestTurn([ENTRY("1", "pi.user", "go"), ENTRY("2", "pi.tool-result", "ok")]),
  ).toStrictEqual({ state: "tool" });
  expect(
    latestTurn([ENTRY("1", "pi.user", "go"), ENTRY("2", "pi.assistant", "done")]),
  ).toStrictEqual({ state: "answer" });
  expect(latestTurn([ENTRY("1", "pi.assistant", "alone")])).toBeNull();
});

// Catches: a tool call read as an empty assistant answer, so a turn that is running a tool
// shows nothing (the wire's text keeps only text parts, so a call arrives as text: "").
test("a tool call with no text is a running tool, not an answer", () => {
  const idle = { kind: "idle" } as const;
  const called = [
    ENTRY("1", "pi.user", "go"),
    { id: "2", kind: "pi.assistant", text: "", hasToolCall: true },
  ];
  expect(latestTurn(called)).toStrictEqual({ state: "tool" });
  expect(progressOf(called, "", idle)).toStrictEqual({
    kind: "tool",
    label: "ツール実行中",
    live: true,
  });

  // The same entry, said explicitly not to be a call, is not a call (and is not an answer
  // either: nothing has been said).
  const empty = [
    ENTRY("1", "pi.user", "go"),
    { id: "2", kind: "pi.assistant", text: "", hasToolCall: false },
  ];
  expect(latestTurn(empty)).toStrictEqual({ state: "waiting" });

  // The call's result has come back: that is still a tool line, of the result, not a call.
  const returned = [...called, ENTRY("3", "pi.tool-result", "ok")];
  expect(latestTurn(returned)).toStrictEqual({ state: "tool" });

  // A caller with only the wire fields (no hasToolCall) reads the empty assistant text as a call.
  expect(latestTurn([ENTRY("1", "pi.user", "go"), ENTRY("2", "pi.assistant", "")])).toStrictEqual({
    state: "tool",
  });
});

// Catches: a stop the person made showing nothing until the view catches up, and the progress
// line claiming the run is thinking after it was stopped.
test("a stop outranks what the transcript still shows", () => {
  const entries = [ENTRY("1", "pi.user", "go")];
  expect(progressOf(entries, "still streaming", { kind: "asked" })?.kind).toBe("thinking");
  expect(progressOf(entries, "still streaming", { kind: "stopped", at: "" })).toStrictEqual({
    kind: "stopped",
    label: "中断されました",
    live: false,
  });
  expect(progressOf(entries, "", { kind: "stopped", at: "" })?.kind).toBe("stopped");
});

// Catches: the state keeping the entries unsorted, so a view depends on the order it happened
// to receive.
test("the conversation state sorts its entries", () => {
  const state = conversationStateOf({
    conversation: CONVERSATION,
    entries: [ENTRY("3", "pi.assistant", "c"), ENTRY("1", "pi.user", "a")],
    draft: "d",
    interrupted: false,
    connection: "online",
    stop: { kind: "idle" },
  });
  expect(state.entries.map((entry) => entry.id)).toStrictEqual(["1", "3"]);
  expect(state.draft).toBe("d");
  expect(state.conversation.title).toBe("Web の土台");
});

/** The URLs one fake fetch was asked for. */
interface FetchCalls {
  readonly calls: string[];
}

/** A fetch that answers one status with one JSON body and records the URL it was asked for. */
function fetchOnce(
  status: number,
  body: JsonValue,
): FetchCalls & { readonly fetch: (input: RequestInfo | URL) => Promise<Response> } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (input) => {
      calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

// Catches: the read becoming a list scan, or reading a route that is not the conversation's.
test("the read asks the conversation's state route once", async () => {
  const once = fetchOnce(200, { conversation: { ...CONVERSATION }, ok: true });
  const read = await readConversationState("conversation-intent", once.fetch);
  expect(once.calls).toStrictEqual(["/api/conversations/conversation-intent/state"]);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.conversation.id).toBe("conversation-intent");
  expect(read.conversation.archived).toBe(false);
  expect(read.entries).toStrictEqual([]);
});

// Catches: an archived conversation's flag being dropped on the way to the screen.
test("an archived row keeps its flag", async () => {
  const once = fetchOnce(200, { conversation: { ...CONVERSATION, archived: true } });
  const read = await readConversationState("conversation-intent", once.fetch);
  expect(read.ok && read.conversation.archived).toBe(true);
});

// Catches: a 404 shown as a retryable outage (a deleted conversation told to wait), and a 5xx
// shown as missing (a working conversation told it never existed).
test("the refusals are told apart", async () => {
  const missing = await readConversationState("x", fetchOnce(404, {}).fetch);
  expect(missing).toStrictEqual({
    ok: false,
    reason: "not_found",
    message: "この会話は見つかりません。",
  });
  const unavailable = await readConversationState("x", fetchOnce(503, {}).fetch);
  expect(unavailable.ok).toBe(false);
  if (unavailable.ok) return;
  expect(unavailable.reason).toBe("unavailable");
  const invalid = await readConversationState("x", fetchOnce(400, {}).fetch);
  expect(invalid.ok || invalid.reason).toBe("invalid");
});

// Catches: a body the reader takes apart field by field, so a truncated answer becomes a
// conversation with empty fields instead of an error.
test("a body that is not the route's is unavailable", async () => {
  const broken = await readConversationState("x", fetchOnce(200, { conversation: null }).fetch);
  expect(broken.ok).toBe(false);
  const notJson = await readConversationState(
    "x",
    async () => new Response("not json", { status: 200 }),
  );
  expect(notJson.ok).toBe(false);
  const failed = await readConversationState("x", async () => {
    throw new TypeError("network");
  });
  expect(failed.ok).toBe(false);
});
