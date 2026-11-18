import {
  parseLiveClientMessage,
  type Conversation,
  type LiveAppendFrame,
  type LiveClientMessage,
  type LiveEntry,
  type LiveSnapshotFrame,
} from "@hns/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { RelayEnvironmentProvider } from "react-relay";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { socketFactory } from "../../../test/live/support.ts";
import { conversationStateBody, interceptFetch } from "../../../test/support/conversation.ts";
import { createTestEnvironment } from "../../../test/support/relay.ts";
import { workspaceFixture } from "../../../test/support/workspaceFixtures.ts";
import { Shell } from "../../app/Shell.tsx";
import { LIVE_RECONNECT_DELAYS_MS, type LiveSocketFactory } from "../../live/client.ts";
import { useLiveConnection } from "../../live/useLiveConnection.ts";
import { ConversationScreen } from "./ConversationScreen.tsx";

const INTENT = "conversation-intent";
const DESIGN = "conversation-design";
/** The draft key the screen keeps this conversation's text under. */
const DRAFT_KEY = "hns.conversation.draft:" + INTENT;
const originalMatchMedia = window.matchMedia;
const originalFetch = globalThis.fetch;

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "";
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

/** A payload the fake socket carries: a frame or an answer, as JSON. */

/** A durable entry as the live protocol carries it. */
type EntryPayload = LiveEntry;

/** A frame the server sends on the conversation a socket follows. */
function snapshotFrame(
  conversationId: string,
  entries: readonly EntryPayload[] = [],
): LiveSnapshotFrame {
  return {
    type: "snapshot",
    protocol: 1,
    cursor: String(entries.length),
    conversationId,
    title: "ウェブの土台",
    entries,
    draft: "",
  };
}

/** An append frame for one more durable entry. */
function appendFrame(conversationId: string, entry: EntryPayload, cursor: string): LiveAppendFrame {
  return {
    type: "append",
    protocol: 1,
    cursor,
    conversationId,
    entries: [entry],
  };
}

/** The commands a fake socket received, parsed by the protocol. */
function sentFrames(socket: { readonly sent: readonly string[] }): LiveClientMessage[] {
  return socket.sent.map((text) => {
    const value: unknown = JSON.parse(text);
    return parseLiveClientMessage(value);
  });
}

/** The conversation route's URL, as the screen builds it. */
function stateUrl(conversationId: string): string {
  return "/api/conversations/" + conversationId + "/state";
}

/** The composer's field: the one textarea the screen has, named by its label. */
function field(): HTMLTextAreaElement {
  const found = screen.getByRole("textbox", { name: "メッセージ" });
  // SAFETY: the composer's field is the screen's only <textarea>; a change of element is a
  // change of the screen and the test's name would no longer say what it checks.
  if (found instanceof HTMLTextAreaElement) return found;
  throw new Error("the composer's field is not a textarea");
}

/** The composer's field and its value, read the way a person would. */
function fieldValue(): string {
  return field().value;
}

/** The composer's submit slot: the one place 送信 and 停止 take turns. */
function submitSlot(): HTMLElement {
  const found = document.body.querySelector(".hns-composer__submit");
  if (found instanceof HTMLElement) return found;
  throw new Error("the composer has no submit slot");
}

/** The progress line's sentence. */
function progressText(): string {
  return document.body.querySelector(".hns-progress")?.textContent ?? "";
}

/**
 * Render the whole shell on a conversation route.
 *
 * @remarks
 * This is the production composition: the shell picks the route, the screen mounts under it, and
 * the one read goes through the browser's `fetch`, which the test intercepts. The only seam is
 * the socket, which the screen always takes and production fills with the browser's WebSocket.
 */
function renderShellOn(conversationId: string) {
  window.location.hash = "#/p/project-hns/c/" + conversationId;
  const { environment } = createTestEnvironment(workspaceFixture);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { factory, sockets } = socketFactory();
  const view = render(
    <RelayEnvironmentProvider environment={environment}>
      <QueryClientProvider client={queryClient}>
        <Shell liveSocket={factory} />
      </QueryClientProvider>
    </RelayEnvironmentProvider>,
  );
  return { ...view, sockets };
}

/**
 * Render the screen by itself, wrapped the way the shell wraps it.
 *
 * @remarks
 * The screen patches the Relay store with the live title, so it needs an environment; it reads
 * its conversation from the route, not from Relay. The read is answered by `renderOpen`.
 */
function mountScreen(conversationId = INTENT) {
  const { factory, sockets } = socketFactory();
  const { environment } = createTestEnvironment(workspaceFixture);
  const view = render(
    <RelayEnvironmentProvider environment={environment}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ScreenAtRoute conversationId={conversationId} socket={factory} />
      </QueryClientProvider>
    </RelayEnvironmentProvider>,
  );
  return { ...view, sockets };
}

/**
 * The screen as its route mounts it: the route owns the one connection and hands it down.
 *
 * @param props.conversationId - The conversation the route names.
 * @param props.socket - The socket factory the visit opens.
 *
 * @remarks
 * The screen never opens a connection. This stands in for the route (the same hook, the same
 * client), so a test drives the socket the production route would have opened, and the
 * screen's sends travel on it.
 */
function ScreenAtRoute({
  conversationId,
  socket,
}: {
  readonly conversationId: string;
  readonly socket: LiveSocketFactory;
}): ReactElement {
  const live = useLiveConnection(conversationId, { socket, projectId: "project-hns" });
  return (
    <ConversationScreen
      conversationId={conversationId}
      projectId="project-hns"
      client={live.client}
    />
  );
}

/**
 * Mount the screen, wait for its read, then open its socket with a snapshot of `entries`.
 *
 * @remarks
 * The order matters. The connection is created once the conversation is known, and a frame
 * delivered before that has no screen to land on; waiting for the composer is what makes the
 * socket exist.
 */
async function renderOpen(entries: readonly EntryPayload[] = [], conversationId = INTENT) {
  // The screen's one read: a file that mounts it without its own stub gets this answer, and a
  // test that stubbed `fetch` for itself (for a refused or held read) keeps its own.
  if (globalThis.fetch === originalFetch) {
    interceptFetch(() => ({ kind: "reply", reply: { body: conversationStateBody() } }));
  }
  const mounted = mountScreen(conversationId);
  await screen.findByLabelText("メッセージ");
  const socket = mounted.sockets.at(-1);
  act(() => {
    socket?.open();
    socket?.message(snapshotFrame(conversationId, entries));
  });
  return { ...mounted, socket };
}

// Catches: the screen finding its conversation by scanning the workspace list (a page read per
// open), or reading anything other than the one state route.
test("the screen reads its conversation from the state route alone", async () => {
  const intercepted = interceptFetch(() => ({
    kind: "reply",
    reply: { body: conversationStateBody() },
  }));

  renderShellOn(INTENT);

  expect(
    await screen.findByText("Web の土台", { selector: "p.hns-conversation__title" }),
  ).toBeTruthy();
  expect(intercepted.requests.map((request) => request.url)).toStrictEqual([stateUrl(INTENT)]);
  expect(intercepted.requests[0]?.method).toBe("GET");
});

// Catches: a body that is not the route's being read as a conversation with empty fields.
test("a body that is not the state route's answer is an error", async () => {
  interceptFetch(() => ({ kind: "reply", reply: { body: { conversation: { title: 1 } } } }));

  renderShellOn(INTENT);

  expect(await screen.findByText("会話を開けません")).toBeTruthy();
});

// Catches: a visit opening more than one connection — the route's for the title and the
// screen's for the transcript — which makes the object serve two subscribers for one conversation,
// lets the two reconnect on their own, and counts the visit twice in whatever observes sockets.
test("one conversation visit opens one socket", async () => {
  interceptFetch(() => ({ kind: "reply", reply: { body: conversationStateBody() } }));

  const { sockets } = renderShellOn(INTENT);
  expect(await screen.findByLabelText("メッセージ")).toBeTruthy();

  // The route's client is created in an effect, so let the commits settle before counting.
  await waitFor(() => {
    expect(sockets).toHaveLength(1);
  });
  act(() => {
    sockets[0]?.open();
  });
  await waitFor(() => {
    expect(document.body.textContent ?? "").toContain("ライブ更新を受信しています。");
  });
  // Nothing in the conversation's render opened a second connection, and neither did its read.
  expect(sockets).toHaveLength(1);
});

// Catches: a 404 shown as a retryable outage, which tells a person to wait for a conversation
// that does not exist (deleted, unknown, or without its object).
test("a conversation the route answers 404 for reads as not found", async () => {
  interceptFetch(() => ({
    kind: "reply",
    reply: { status: 404, body: { ok: false, code: "not_found" } },
  }));

  renderShellOn(INTENT);

  expect(await screen.findByText("この会話は見つかりません。")).toBeTruthy();
});

// Catches: a deleted conversation leaving its draft key behind, one per conversation that was
// ever opened and later deleted.
test("a conversation the route answers 404 for forgets its draft", async () => {
  window.localStorage.setItem(DRAFT_KEY, "消えた会話の書きかけ");
  interceptFetch(() => ({ kind: "reply", reply: { status: 404, body: { ok: false } } }));

  renderShellOn(INTENT);

  expect(await screen.findByText("この会話は見つかりません。")).toBeTruthy();
  expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
});

// Catches: a 404 for one conversation clearing another conversation's draft.
test("a 404 forgets only the conversation it names", async () => {
  const other = "hns.conversation.draft:" + DESIGN;
  window.localStorage.setItem(other, "別の会話の書きかけ");
  window.localStorage.setItem(DRAFT_KEY, "消えた会話の書きかけ");
  interceptFetch(() => ({ kind: "reply", reply: { status: 404, body: { ok: false } } }));

  renderShellOn(INTENT);

  expect(await screen.findByText("この会話は見つかりません。")).toBeTruthy();
  expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  expect(window.localStorage.getItem(other)).toBe("別の会話の書きかけ");
});

// Catches: a failed read leaving the screen blank, with no way back to the workspace.
test("a failed read says so and offers the way back", async () => {
  interceptFetch(() => ({ kind: "network" }));

  renderShellOn(INTENT);

  expect(await screen.findByText("会話を読み込めませんでした。")).toBeTruthy();
  expect(screen.getByRole("link", { name: "ワークスペースへ戻る" }).getAttribute("href")).toBe(
    "#/p/project-hns",
  );
});

// Catches: a read in flight shown as an empty conversation, which reads as "nothing was said".
test("a read in flight is the loading state", async () => {
  const stub = interceptFetch(() => ({ kind: "pending" }));

  renderShellOn(INTENT);

  expect(await screen.findByLabelText("読み込み中")).toBeTruthy();
  expect(document.body.textContent ?? "").not.toContain("まだメッセージがありません");
  await waitFor(() => {
    expect(stub.requests.length).toBeGreaterThan(0);
  });
  act(() => {
    stub.release({ body: conversationStateBody() });
  });
  expect(
    await screen.findByText("Web の土台", { selector: "p.hns-conversation__title" }),
  ).toBeTruthy();
});

// Catches: an archived conversation looking like any other, so a person cannot tell it was put
// away; and the archived flag being lost by reading a summary instead of the row.
test("an archived conversation says so", async () => {
  const archived: Partial<Conversation> = { archived: true };
  interceptFetch(() => ({ kind: "reply", reply: { body: conversationStateBody(archived) } }));

  renderShellOn(INTENT);

  expect(await screen.findByText("アーカイブ済み")).toBeTruthy();
});

// Catches: a transcript that shows nothing because the socket is down, instead of the entries
// the state read already carried.
test("the transcript starts from the entries the state read carried", async () => {
  interceptFetch(() => ({
    kind: "reply",
    reply: {
      body: {
        ...conversationStateBody(),
        entries: [{ id: "1", kind: "pi.user", text: "前の会話" }],
      },
    },
  }));

  renderShellOn(INTENT);

  expect(await screen.findByText("前の会話")).toBeTruthy();
});

// Catches: the store's vocabulary on screen, which is what "no pi.*" forbids.
test("the transcript shows the text and never the entry kind", async () => {
  await renderOpen([
    { id: "1", kind: "pi.user", text: "次の手順は？" },
    { id: "2", kind: "pi.assistant", text: "まず `codegen` を走らせる。" },
    { id: "3", kind: "pi.tool-result", text: "exit 0" },
  ]);

  expect(await screen.findByText("次の手順は？")).toBeTruthy();
  expect(document.querySelector("code")?.textContent).toBe("codegen");
  expect(document.body.textContent ?? "").not.toMatch(/pi\./u);
});

// Catches: a tool result printed in full, burying the answer under its diagnostics.
test("a tool result is folded until the reader opens it", async () => {
  await renderOpen([
    { id: "1", kind: "pi.user", text: "走らせて" },
    { id: "2", kind: "pi.tool-result", text: "first line\nsecond line" },
  ]);

  const toggle = await screen.findByRole("button", { name: /ツール/u });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(document.body.textContent ?? "").not.toContain("second line");

  await userEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(document.body.textContent ?? "").toContain("second line");
});

// Catches: model text reaching the DOM as markup (the screen draws strings, never HTML).
test("model text written as markup stays text", async () => {
  await renderOpen([
    {
      id: "1",
      kind: "pi.assistant",
      text: '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>',
    },
  ]);

  expect(await screen.findByText(/<img src=x/u)).toBeTruthy();
  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector("script")).toBeNull();
  expect("__xss" in window).toBe(false);
});

// Catches: a send that leaves the field full (a second Enter sends the same turn again), or a
// second Enter while the first is unanswered starting another.
test("Enter sends once, empties the field, and refuses a second send until answered", async () => {
  const { socket } = await renderOpen();
  await userEvent.type(screen.getByLabelText("メッセージ"), "こんにちは{Enter}");

  expect(fieldValue()).toBe("");
  const sends = sentFrames(socket!).filter((frame) => frame["type"] === "send");
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ conversationId: INTENT, text: "こんにちは" });
  expect(String(sends[0]?.["clientMessageId"] ?? "")).not.toBe("");
  expect(screen.getByRole("button", { name: "送信" }).getAttribute("disabled") !== null).toBe(true);
});

// Catches: two Enter presses before the first answer putting two turns on the wire.
test("a repeated Enter sends one turn", async () => {
  const { socket } = await renderOpen();
  await userEvent.type(screen.getByLabelText("メッセージ"), "一つだけ{Enter}");
  await userEvent.type(screen.getByLabelText("メッセージ"), "二度目{Enter}");

  const sends = sentFrames(socket!).filter((frame) => frame["type"] === "send");
  expect(sends.map((frame) => frame["text"])).toStrictEqual(["一つだけ"]);
});

// Catches: an IME picking a candidate being taken as the send key, which sends half a word.
test("an Enter that ends a composition does not send", async () => {
  const { socket } = await renderOpen();
  const field = screen.getByLabelText("メッセージ");
  await userEvent.type(field, "にほんご");
  act(() => {
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
  await userEvent.type(field, "{Enter}");
  act(() => {
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });

  expect(sentFrames(socket!).filter((frame) => frame["type"] === "send")).toHaveLength(0);
});

// Catches: a rejected send leaving an empty field and no turn, so the person loses what they
// wrote.
test("a rejected send says why and puts the text back while the field is still empty", async () => {
  const { socket } = await renderOpen();
  await userEvent.type(screen.getByLabelText("メッセージ"), "こんにちは{Enter}");
  const send = sentFrames(socket!).find((frame) => frame["type"] === "send");
  act(() => {
    socket?.message({
      type: "rejected",
      clientMessageId: String(send?.["clientMessageId"] ?? ""),
      code: "unknown_conversation",
      message: "no",
    });
  });

  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "この会話は送信できません。",
  );
  expect(fieldValue()).toBe("こんにちは");
});

// Catches: a send made while the socket is down being dropped rather than written on the next
// connection, which loses the turn for anyone who typed during a reconnect.
test("a send made while disconnected goes out on the next connection", async () => {
  const { sockets } = await renderOpen();
  act(() => {
    sockets.at(-1)?.drop();
  });
  await userEvent.type(screen.getByLabelText("メッセージ"), "待ってた{Enter}");
  expect(sentFrames(sockets.at(-1)!).filter((f) => f["type"] === "send")).toHaveLength(0);

  await vi.waitFor(() => {
    expect(sockets).toHaveLength(2);
  });
  act(() => {
    sockets[1]?.open();
    sockets[1]?.message(snapshotFrame(INTENT));
  });

  const resent = sentFrames(sockets[1]!).filter((frame) => frame["type"] === "send");
  expect(resent).toHaveLength(1);
  expect(resent[0]).toMatchObject({ text: "待ってた" });
});

// Catches: the stop button moving when the run starts, or a stop that never reaches the socket.
test("the stop button is in the send button's slot and sends one abort", async () => {
  const { socket } = await renderOpen();
  const slot = submitSlot();
  expect(within(slot).getByRole("button", { name: "送信" })).toBeTruthy();

  await userEvent.type(field(), "長い仕事を頼む{Enter}");
  act(() => {
    socket?.message(appendFrame(INTENT, { id: "1", kind: "pi.user", text: "長い仕事を頼む" }, "1"));
  });

  const stop = within(slot).getByRole("button", { name: "停止" });
  await userEvent.click(stop);

  expect(sentFrames(socket!).filter((frame) => frame.type === "abort")).toStrictEqual([
    { type: "abort", conversationId: INTENT },
  ]);
  expect(stop.getAttribute("disabled")).not.toBeNull();
});

// Catches: an aborted run leaving the transcript looking like an answer, so a refusal reads as
// the model's reply.
test("an aborted run says so in the transcript and in the progress line", async () => {
  await renderOpen([
    { id: "1", kind: "pi.user", text: "走らせて" },
    { id: "2", kind: "pi.assistant.aborted", text: "半分まで" },
  ]);

  await screen.findByText("半分まで");
  expect(progressText()).toContain("中断されました");
});

// Catches: the stop button's own confirmation waiting for the view, which leaves the person
// staring at a button they already pressed.
test("a stop the person made says so before the view does", async () => {
  const { socket } = await renderOpen();
  await userEvent.type(screen.getByLabelText("メッセージ"), "長い仕事{Enter}");
  act(() => {
    socket?.message(appendFrame(INTENT, { id: "1", kind: "pi.user", text: "長い仕事" }, "1"));
  });
  await userEvent.click(screen.getByRole("button", { name: "停止" }));

  expect(progressText()).toContain("中断されました");
});

/* oxlint-disable anti-slop/no-runtime-typeof -- the platform's fetch input is a Request, a URL,
   or a URL string; this file reads which one the stubbed fetch was given.
*/

/** The repository root, whether vitest runs from there or from the package. */
function repositoryRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, "packages/web/src"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repository root not found");
    dir = parent;
  }
}

/**
 * The files of the conversation screen, as they ship.
 *
 * @remarks
 * The screen's own directory: the renderer, the composer, the transcript, and the modules
 * between them. Tests are skipped; the check is about what ships.
 */
function screenSources(): readonly { readonly name: string; readonly source: string }[] {
  const dir = join(repositoryRoot(), "packages/web/src/screens/conversation");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
    .map((name) => ({
      name,
      source: stripComments(readFileSync(join(dir, name), "utf8")),
    }));
}

/** The code of one file, without its comments: a note about `pi.*` is not a use of it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
}

// Catches: the store's vocabulary drawn into the markup, which is what a screen that echoes a
// kind instead of choosing one does. The component test above catches it at runtime; this
// catches it in a branch that test never reaches, before a person has to trip it.
test("no screen draws a durable entry kind", () => {
  const offenders = screenSources()
    .filter(
      (file) =>
        // A kind used as data (the translation table) is fine; a kind rendered into a component
        // or a label is not.
        />\s*[^>]*\bpi\./u.test(file.source) || /:\s*"pi\.[^"]*"/u.test(file.source),
    )
    .map((file) => file.name);
  expect(offenders).toStrictEqual([]);
});

// Catches: a draft lost when the conversation changes, which is the one thing a long message
// cannot afford.
test("each conversation keeps its own draft", async () => {
  interceptFetch(() => ({ kind: "reply", reply: { body: conversationStateBody() } }));
  const first = mountScreen(INTENT);
  await screen.findByLabelText("メッセージ");
  await userEvent.type(screen.getByLabelText("メッセージ"), "書きかけ");
  first.unmount();

  const other = interceptFetch(() => ({
    kind: "reply",
    reply: {
      body: conversationStateBody({ id: DESIGN, title: "デザインシステムのレビュー" }),
    },
  }));
  mountScreen(DESIGN);
  expect(
    await screen.findByText("デザインシステムのレビュー", {
      selector: "p.hns-conversation__title",
    }),
  ).toBeTruthy();
  expect(fieldValue()).toBe("");
  other.restore();
});

// Catches: a reload losing the draft, which is the case a person cannot redo by hand.
test("a reload finds the draft where it was left", async () => {
  interceptFetch(() => ({ kind: "reply", reply: { body: conversationStateBody() } }));
  const view = mountScreen(INTENT);
  await screen.findByText("Web の土台", { selector: "p.hns-conversation__title" });
  await userEvent.type(screen.getByLabelText("メッセージ"), "リロードしても残る");
  view.unmount();

  interceptFetch(() => ({ kind: "reply", reply: { body: conversationStateBody() } }));
  mountScreen(INTENT);
  expect(
    await screen.findByText("Web の土台", { selector: "p.hns-conversation__title" }),
  ).toBeTruthy();
  expect(fieldValue()).toBe("リロードしても残る");
});

// Catches: the progress line saying the run is idle while a tool is executing or the turn waits,
// or the draft never appearing while the answer streams in.
test("the progress line says what the run is doing", async () => {
  const { socket } = await renderOpen([{ id: "1", kind: "pi.assistant", text: "了解" }]);
  act(() => {
    socket?.message(appendFrame(INTENT, { id: "2", kind: "pi.user", text: "走らせて" }, "2"));
  });
  expect(progressText()).toContain("待ち");

  act(() => {
    socket?.message(appendFrame(INTENT, { id: "3", kind: "pi.tool-result", text: "ok" }, "3"));
  });
  expect(progressText()).toContain("ツール実行中");

  act(() => {
    socket?.message({
      type: "delta",
      protocol: 1,
      conversationId: INTENT,
      text: "答えの途中",
      replace: false,
    });
  });
  expect(progressText()).toContain("考え中");
  expect(document.body.textContent ?? "").toContain("答えの途中");

  // The turn answers: the line is quiet, and the committed tool result above does not make it
  // say a tool is executing now that the turn is over.
  act(() => {
    socket?.message(appendFrame(INTENT, { id: "4", kind: "pi.assistant", text: "答え" }, "4"));
  });
  expect(progressText()).toBe("");
});

/** The transcript's scroll container. */
function scroller(): HTMLElement {
  const found = document.body.querySelector(".hns-transcript__scroll");
  if (found instanceof HTMLElement) return found;
  throw new Error("the transcript has no scroll container");
}

/**
 * Give the scroll container the numbers a laid-out element would have.
 *
 * @param element - The transcript's scroll container.
 * @param scrollTop - How far down the reader is.
 * @param scrollHeight - How tall the content is.
 * @param clientHeight - How tall the viewport is.
 */
function setMetrics(
  element: HTMLElement,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): void {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: clientHeight });
  element.scrollTop = scrollTop;
}

// Catches: a 最新へ button that is offered but does nothing, or one that stays after the reader
// asked for the end — the reader then cannot tell whether the view moved.
test("最新へ comes back to the newest line and is gone once the reader is there", async () => {
  const { socket } = await renderOpen([{ id: "1", kind: "pi.user", text: "最初の行" }]);
  const element = scroller();
  // jsdom lays nothing out, so the numbers the rule reads are supplied: the reader has scrolled
  // up, far from the end.
  setMetrics(element, 0, 1000, 100);
  act(() => {
    element.dispatchEvent(new Event("scroll"));
  });

  const button = await screen.findByRole("button", { name: "最新へ" });

  // The click takes the view to the end and records it; the button goes away with the jump.
  await userEvent.click(button);
  expect(element.scrollTop).toBe(900);
  expect(screen.queryByRole("button", { name: "最新へ" })).toBeNull();

  // The reader is at the end now, so the next line does not bring the button back.
  act(() => {
    socket?.message(appendFrame(INTENT, { id: "2", kind: "pi.assistant", text: "次の行" }, "2"));
  });
  expect(await screen.findByText("次の行")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "最新へ" })).toBeNull();
});

// Catches: a long answer drawn as one unbroken node, or a long conversation re-sorting or
// dropping entries.
test("a long answer and a hundred messages render whole", async () => {
  const long = "長い行\n".repeat(2000);
  const hundred = Array.from({ length: 100 }, (_, index) => ({
    id: String(index + 1),
    kind: index % 2 === 0 ? "pi.user" : "pi.assistant",
    text: "メッセージ " + String(index + 1),
  }));
  await renderOpen([...hundred, { id: "101", kind: "pi.assistant", text: long }]);

  expect(await screen.findByText("メッセージ 100")).toBeTruthy();
  const items = [...document.querySelectorAll(".hns-transcript__list > li")];
  expect(items).toHaveLength(101);
  expect(items[0]?.textContent).toContain("メッセージ 1");
  expect(items[99]?.textContent).toContain("メッセージ 100");
  expect(items[100]?.textContent?.length ?? 0).toBeGreaterThan(long.length / 2);
});

// Catches: an empty conversation showing a blank region with no way to start.
test("an empty conversation says it is empty", async () => {
  await renderOpen([]);

  expect(await screen.findByLabelText("空の会話")).toBeTruthy();
  expect(screen.getByLabelText("メッセージ")).toBeTruthy();
});

// Catches: the screen going quiet when the connection is gone, leaving a person typing into a
// composer that cannot send.
test("an offline connection says so and refuses the send", async () => {
  const { sockets } = await renderOpen();
  // Each drop schedules one reconnect, so the drops are spread over the client's delays: the
  // last reconnect fails and the client gives up instead of retrying forever.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    act(() => {
      sockets.at(-1)?.drop();
    });
    const delay = LIVE_RECONNECT_DELAYS_MS[attempt] ?? 0;
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, delay + 100);
      });
    });
  }

  await vi.waitFor(() => {
    expect(
      document.body.querySelector(".hns-conversation__connection")?.getAttribute("data-state"),
    ).toBe("offline");
  });
  await userEvent.type(screen.getByLabelText("メッセージ"), "送れない{Enter}");

  // The composer says why it cannot send, and the field keeps what was written.
  const composer = document.querySelector(".hns-composer");
  expect(composer?.textContent ?? "").toContain("未接続です。再読み込みすると再開します。");
  expect(fieldValue()).toBe("送れない");
});
