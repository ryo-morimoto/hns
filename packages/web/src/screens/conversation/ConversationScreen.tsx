import type { Conversation, LiveSendResult } from "@hns/core";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Skeleton } from "../../components/Skeleton.tsx";
import type { LiveClient } from "../../live/client.ts";
import { explainConnection, type LiveConversationState } from "../../live/state.ts";
import { formatHash } from "../../routes/route.ts";
import { Composer } from "./Composer.tsx";
import { browserDraftStorage, readDraft, writeDraft } from "./drafts.ts";
import { Transcript } from "./Transcript.tsx";
import {
  conversationStateOf,
  isInterrupted,
  mergeEntries,
  progressOf,
  readConversationState,
  transcriptOf,
  type LiveEntryLike,
  type StopState,
} from "./transcript.ts";
import "./conversation.css";

/** What the screen shows while it reads the conversation, then what it found. */
type ReadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string; readonly notFound: boolean }
  | {
      readonly kind: "ready";
      readonly conversation: Conversation;
      readonly entries: readonly LiveEntryLike[];
    };

/**
 * One conversation: its transcript, its progress, and the two commands.
 *
 * @param props.conversationId - The conversation the route names.
 * @param props.liveSocket - Test seam; production passes the browser's WebSocket.
 * @param props.readState - Test seam; production reads `/api/conversations/:id/state`.
 * @param props.storage - Test seam; production uses the browser's local storage.
 *
 * @remarks
 * **The read is one request.** `/api/conversations/:id/state` is the row and the object's state
 * in one answer; the screen never scans a list to find its conversation, because which
 * conversations exist is the list's question (0121) and answering it here would make opening one
 * cost a page. The socket then carries what changes.
 *
 * **What is not streaming yet.** The draft (`delta`) arrives, and an append carrying the
 * committed entries is what replaces it — there is no per-token event that also refreshes the
 * task or the queue, because that event type is not defined yet: the screen works from the view
 * the socket carries and re-reads nothing while it is up. When that event type lands, it is the
 * one place this changes; until then the state the socket sends is the whole of what moves.
 *
 * TODO(0050): replace the view-plus-refetch arrangement with 0050's typed stream events when
 * they exist; nothing here assumes they never will.
 *
 * **The socket carries the commands.** A turn goes out as a `send` frame with the client's own
 * id, and its answer (`accepted` / `rejected`) is what lets the screen stop waiting; a stop is an
 * `abort` frame. There is no POST: the edge has no send route, and adding one here would be a
 * second way to start a run.
 *
 * **The draft is the conversation's, not the screen's.** It is written to storage on every
 * keystroke and read back when the conversation is opened, so switching, going back, and a
 * reload all find it where it was.
 */
export function ConversationScreen({
  conversationId,
  projectId,
  client,
  readState,
  storage,
  randomId,
}: {
  readonly conversationId: string;
  /** The project the route names; it is where the way back points. */
  readonly projectId: string;
  /**
   * The conversation's one live connection, owned by the route.
   *
   * @remarks
   * The screen never opens one. The route's client is what carries the sends and stops this
   * screen issues and what its transcript follows, so one visit has one socket; null (a shell
   * rendered without one) draws the conversation the read returned and no live part.
   */
  readonly client: LiveClient | null;
  /**
   * Test seam for the one read.
   *
   * @remarks
   * Production omits it and the screen reads `/api/conversations/:id/state` itself, through the
   * browser's `fetch`; a test that stubs `fetch` therefore exercises the production reader.
   * The seam exists for an answer the route would not give (a read that stays open).
   */
  readonly readState?: typeof readConversationState | undefined;
  readonly storage?: ReturnType<typeof browserDraftStorage> | undefined;
  /**
   * The id factory one send's `clientMessageId` comes from.
   *
   * @remarks
   * Production omits it and the screen asks the platform (`crypto.randomUUID`). It is a seam
   * rather than a global lookup in the screen because an id a test cannot predict is an id a
   * test cannot check against the answer it is given.
   */
  readonly randomId?: (() => string) | undefined;
}): ReactElement {
  // The answer carries the conversation it belongs to: a route change must show the loading
  // state for the new conversation at once, without a state reset written from an effect (which
  // would be a second render, and a second socket, for one visit).
  const [read, setRead] = useState<{ readonly for: string; readonly state: ReadState }>({
    for: conversationId,
    state: { kind: "loading" },
  });
  const current: ReadState = read.for === conversationId ? read.state : { kind: "loading" };
  const store = useRef<ReturnType<typeof browserDraftStorage> | undefined>(storage);
  store.current = storage;

  useEffect(() => {
    let live = true;
    const load = async (): Promise<void> => {
      let found: Awaited<ReturnType<typeof readConversationState>>;
      try {
        found =
          readState === undefined
            ? await readConversationState(conversationId)
            : await readState(conversationId);
      } catch {
        // The reader answers a broken body and a dead connection as values; a throw is one this
        // screen did not foresee, and it still must not take the shell down with it.
        found = { ok: false, reason: "unavailable", message: "会話を読み込めませんでした。" };
      }
      if (!live) return;
      setRead({
        for: conversationId,
        state: found.ok
          ? { kind: "ready", conversation: found.conversation, entries: found.entries }
          : { kind: "error", message: found.message, notFound: found.reason === "not_found" },
      });
    };
    void load();
    return () => {
      live = false;
    };
  }, [conversationId, readState]);

  if (current.kind === "loading") return <LoadingConversation />;
  if (current.kind === "error") {
    return <FailedConversation message={current.message} projectId={projectId} />;
  }
  return (
    <LoadedConversation
      key={conversationId}
      conversationId={conversationId}
      conversation={current.conversation}
      storedEntries={current.entries}
      client={client}
      storage={store.current ?? browserDraftStorage()}
      randomId={randomId}
    />
  );
}

/** The loading state: the conversation's shape, not a spinner in the middle of nothing. */
function LoadingConversation(): ReactElement {
  return (
    <section className="hns-conversation" aria-label="読み込み中" aria-busy="true">
      <div className="hns-conversation__scroll">
        <Skeleton width={220} height={16} />
        <Skeleton width={360} height={12} />
        <Skeleton width={300} height={12} />
      </div>
    </section>
  );
}

/** The error state: what happened and the one way out. */
function FailedConversation({
  message,
  projectId,
}: {
  readonly message: string;
  readonly projectId: string;
}): ReactElement {
  return (
    <section className="hns-conversation" aria-label="読み込み失敗">
      <div className="hns-conversation__failure">
        <h2>会話を開けません</h2>
        <p className="hns-view__note">{message}</p>
        <BackLink projectId={projectId} />
      </div>
    </section>
  );
}

/** The part of the connection the screen renders: the entries, the draft, and the status. */
interface LiveView {
  readonly entries: readonly LiveEntryLike[];
  readonly draft: string;
  readonly status: "connecting" | "online" | "reconnecting" | "offline";
}

/** A command the composer issued and has not seen answered yet. */
interface OutstandingSend {
  readonly clientMessageId: string;
  readonly text: string;
}

/**
 * Create one client-side id for a turn.
 *
 * @param randomId - A uuid factory; production passes the platform's, a test a fixed sequence.
 * @returns A random id; the same id in two requests is the same turn.
 */
function newClientMessageId(randomId: () => string): string {
  return randomId();
}

/** The platform's uuid source, which every browser this app targets provides. */
function defaultRandomId(): string {
  return crypto.randomUUID();
}

interface LoadedProps {
  readonly conversationId: string;
  readonly conversation: Conversation;
  readonly storedEntries: readonly LiveEntryLike[];
  readonly client: LiveClient | null;
  readonly storage: ReturnType<typeof browserDraftStorage>;
  readonly randomId: (() => string) | undefined;
}

/** The screen once the conversation is known: live view, transcript, and composer. */
function LoadedConversation({
  conversationId,
  conversation,
  storedEntries,
  client: given,
  storage,
  randomId,
}: LoadedProps): ReactElement {
  const [live, setLive] = useState<LiveView>({
    entries: [],
    draft: "",
    status: "connecting",
  });
  const [draft, setDraft] = useState(() => readDraft(storage ?? null, conversationId));
  const [stop, setStop] = useState<StopState>({ kind: "idle" });
  const [outstanding, setOutstanding] = useState<OutstandingSend | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const waiting = useRef<OutstandingSend | null>(null);
  // The answer arrives after this render, so the draft store the composer writes to is read
  // through a ref rather than captured.
  const storageRef = useRef(storage);
  storageRef.current = storage;
  /** The command the next commit must put on the socket; an effect writes it. */
  const pendingCommand = useRef<{ readonly kind: "abort" } | undefined>(undefined);

  const onSendResult = useCallback(
    (result: LiveSendResult) => {
      const pending = waiting.current;
      if (pending === null || pending.clientMessageId !== result.clientMessageId) return;
      waiting.current = null;
      setOutstanding(null);
      if (result.type === "rejected") {
        setFailure(rejectionText(result));
        // The text goes back only into the field the turn was written in: a person who has
        // already started the next message keeps it, and the failed text is gone with the notice.
        setDraft((current) => {
          if (current !== "") return current;
          writeDraft(storageRef.current, conversationId, pending.text);
          return pending.text;
        });
      }
    },
    [conversationId],
  );

  // The route's client answers every send it carries; the screen listens for the answers to the
  // sends it made, and its own outstanding one is cleared above. The same client is where the
  // screen's live state comes from: its transcript, the draft, and the status line are all the
  // one connection the route owns.
  useEffect(() => {
    if (given === null) {
      setLive({ entries: [], draft: "", status: "connecting" });
      return;
    }
    const apply = (next: LiveConversationState): void => {
      setLive((previous) =>
        previous.entries === next.entries &&
        previous.draft === next.draft &&
        previous.status === next.status
          ? previous
          : { entries: next.entries, draft: next.draft, status: next.status },
      );
    };
    apply(given.state);
    const unsubscribeState = given.subscribe(apply);
    const unsubscribeAnswers = given.onSendResult(onSendResult);
    return () => {
      unsubscribeState();
      unsubscribeAnswers();
    };
  }, [given, onSendResult]);

  const entries = mergeEntries(storedEntries, live.entries);
  const state = conversationStateOf({
    conversation,
    entries,
    draft: live.draft,
    interrupted: isInterrupted(entries),
    connection: live.status,
    // The stop the person made is the screen's own fact and outranks the view's: until the
    // transcript shows the stopped run, the line must say what was done, not what it guesses.
    stop: stop.kind === "asked" ? { kind: "stopped", at: "" } : stop,
  });
  const items = transcriptOf(state.entries);
  const progress = progressOf(state.entries, state.draft, state.stop);
  // The slot flips on the run showing itself, not on the send's answer: a run whose send is
  // still unacknowledged must still be stoppable.
  const progressKindIsRunning = progress !== null && progress.kind !== "stopped";
  const empty = items.length === 0 && state.draft === "";
  const connection = explainConnection({
    status: live.status,
    entries: state.entries,
    draft: state.draft,
    cursor: "",
    attempt: 0,
    error: null,
  });

  const updateDraft = (next: string): void => {
    setDraft(next);
    setFailure(null);
    writeDraft(storage, conversationId, next);
  };

  const send = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed === "" || outstanding !== null) return;
    // The field empties first: the send is what the person asked for, and the text they typed
    // is now one turn, not a draft that can be sent twice.
    updateDraft("");
    const pending: OutstandingSend = {
      clientMessageId: newClientMessageId(randomId ?? defaultRandomId),
      text: trimmed,
    };
    const put = given?.send(pending.clientMessageId, trimmed, conversationId) ?? null;
    if (put === "offline") {
      // The client has given up reconnecting, so this send will never go out on its own; it is
      // neither queued nor waiting, and the field it came from gets it back.
      given?.abandonSend(pending.clientMessageId);
      setFailure("未接続のため送信できませんでした。再読み込みすると再開します。");
      updateDraft(trimmed);
      return;
    }
    waiting.current = pending;
    setOutstanding(pending);
    setStop({ kind: "idle" });
  };

  const stopRun = (): void => {
    if (stop.kind !== "idle") return;
    // The confirmation is a state update, so it commits on the next render; the command is
    // written by an effect that also waits for that render to report, so the line and the
    // command are never a render apart.
    setStop({ kind: "asked" });
    pendingCommand.current = { kind: "abort" };
  };

  // One place sends the stop, and it is a commit of its own rather than the click handler.
  useEffect(() => {
    const command = pendingCommand.current;
    if (command === undefined) return;
    pendingCommand.current = undefined;
    if (given !== null && given.abort(conversationId)) return;
    setStop({ kind: "idle" });
    setFailure("接続していないため停止できません。");
  }, [stop, conversationId]);

  return (
    <section className="hns-conversation" aria-label="会話">
      <header className="hns-conversation__header">
        {/*
          The title is a text, not a heading: the route already has one (the conversation's own
          h1 in the chrome), and a second heading with the same name makes the page ambiguous to
          a person navigating by heading.
        */}
        <div className="hns-conversation__titles">
          <p className="hns-conversation__title">{state.conversation.title}</p>
          {state.conversation.archived ? (
            <span className="hns-conversation__archived" data-archived="true">
              アーカイブ済み
            </span>
          ) : null}
        </div>
        <p className="hns-conversation__connection" data-state={live.status}>
          {connection.label} · {connection.detail}
        </p>
      </header>
      <Transcript items={items} draft={state.draft} empty={empty} progress={progress} />
      <Composer
        value={draft}
        onChange={updateDraft}
        onSend={send}
        onStop={stopRun}
        // Sending waits for the previous turn's answer; stopping does not, because the run it
        // stops is the one that answer would end.
        canSend={outstanding === null}
        running={progressKindIsRunning}
        blockedReason={
          live.status === "offline" ? "未接続です。再読み込みすると再開します。" : null
        }
        failure={failure}
        run={{
          running: progressKindIsRunning,
          stopped: stop.kind === "stopped" || state.interrupted,
        }}
      />
    </section>
  );
}

/** The sentence a rejected send shows. */
function rejectionText(result: LiveSendResult): string {
  if (result.type === "accepted") return "";
  switch (result.code) {
    case "invalid_text":
      return "送信できない文字列です。";
    case "unknown_conversation":
      return "この会話は送信できません。";
    case "unavailable":
      return "送信できませんでした。もう一度試してください。";
    default: {
      const unhandled: never = result.code;
      throw new Error("unhandled send rejection: " + String(unhandled));
    }
  }
}

/** The route that leaves this conversation, so the header always has a way back. */
function workspaceHref(projectId: string): string {
  return formatHash({ kind: "workspace", projectId });
}

/** The way back to the workspace, which every state of the screen keeps visible. */
function BackLink({ projectId }: { readonly projectId: string }): ReactElement {
  return (
    <a className="hns-view__link" href={workspaceHref(projectId)}>
      ワークスペースへ戻る
    </a>
  );
}
