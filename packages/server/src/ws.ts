import type { AgentLiveView, AgentLiveWatch, AgentSession } from "@hns/agent/session";
import type { EntryRecord } from "@earendil-works/pi-durable";
import {
  chunkLiveText,
  err,
  LIVE_DELTA_MAX_BYTES,
  LIVE_PROTOCOL_VERSION,
  LiveDeltaBatcher,
  liveCursorOf,
  liveCursorValue,
  ok,
  parseLiveClientMessage,
  type LiveAcceptedFrame,
  type LiveClientMessage,
  type LiveEntry,
  type LiveErrorCode,
  type LiveFrame,
  type LiveRejectedFrame,
  type LiveSendRejectionCode,
  type LiveSendResult,
  type Result,
} from "@hns/core";
import * as v from "valibot";
import { problem } from "./edge/problem.ts";

/** What is stored on a socket so a later incarnation can resume it. */
export interface LiveAttachment {
  readonly conversationId: string;
  readonly cursor: string;
}

/** The subset of the Workers WebSocket API the live face uses. */
export interface LiveSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Hibernation: store this socket's subscription across eviction. */
  serializeAttachment?(value: LiveAttachment): void;
  /** Hibernation: read the subscription back after eviction. */
  deserializeAttachment?(): LiveAttachment | undefined;
  readonly readyState?: number;
}

/** The pair a Workers `WebSocketPair` returns: client at 0, server at 1. */
export interface LiveSocketPair {
  readonly 0: LiveSocket;
  readonly 1: LiveSocket;
}

/** Builds a socket pair; tests inject a pair that records sends. */
export type LiveSocketPairFactory = () => LiveSocketPair;

/** The Durable Object methods that accept and enumerate hibernatable sockets. */
export interface LiveSocketHost {
  acceptWebSocket(socket: LiveSocket, tags?: readonly string[]): void;
  getWebSockets(tag?: string): readonly LiveSocket[];
}

/** A successful upgrade and the objects that keep it live. */
interface OpenedLiveSocket {
  readonly response: Response;
  /** The client half; the caller returns `response` to the runtime. */
  readonly client: LiveSocket;
  readonly socket: LiveSocket;
  readonly connection: LiveConnection;
  readonly watch: AgentLiveWatch;
}

/** A failed upgrade; the response is a typed problem. */
export type LiveUpgradeResult = Result<OpenedLiveSocket, Response>;

const DecimalIdSchema = v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/u));
const CursorSchema = v.pipe(v.string(), v.regex(/^(0|[1-9][0-9]*)$/u));
const UpgradeQuerySchema = v.object({
  conversationId: DecimalIdSchema,
  cursor: v.optional(CursorSchema),
});
const AttachmentSchema = v.object({
  conversationId: DecimalIdSchema,
  cursor: v.optional(CursorSchema, "0"),
});

/** Whether the request asks for a WebSocket upgrade. */
function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

declare global {
  /**
   * The Workers runtime's socket pair constructor.
   *
   * @remarks
   * Not in lib.dom, and absent in Node; tests inject a pair instead of relying on it.
   */
  var WebSocketPair: (new () => LiveSocketPair) | undefined;
}

/**
 * The process-wide `WebSocketPair` constructor.
 *
 * @throws Error when the Workers runtime does not provide it (Node tests inject a pair).
 */
export function defaultWebSocketPair(): LiveSocketPair {
  const ctor = globalThis.WebSocketPair;
  if (ctor === undefined) {
    throw new Error("WebSocketPair is unavailable");
  }
  return new ctor();
}

/**
 * Read the subscription stored on a hibernated socket.
 *
 * @returns The attachment, or undefined when it is missing or malformed.
 *
 * @remarks
 * A malformed attachment is closed by the caller rather than guessed: a connection with the
 * wrong conversation would leak another conversation's updates.
 */
export function readLiveAttachment(socket: LiveSocket): LiveAttachment | undefined {
  if (socket.deserializeAttachment === undefined) return undefined;
  let raw: unknown;
  try {
    raw = socket.deserializeAttachment();
  } catch {
    return undefined;
  }
  const parsed = v.safeParse(AttachmentSchema, raw);
  return parsed.success ? parsed.output : undefined;
}

/** Builds the 101 response that hands the client half to the runtime. */
export type LiveUpgradeResponseFactory = (client: LiveSocket) => Response;

/**
 * The production upgrade response.
 *
 * @remarks
 * Node's `Response` refuses status 101, so unit tests inject a factory that returns a plain
 * response; the cf dev integration proves the real 101.
 */
export function defaultLiveUpgradeResponse(client: LiveSocket): Response {
  const init: ResponseInit & { readonly webSocket?: unknown } = { status: 101, webSocket: client };
  return new Response(null, init);
}

/** The text an entry contributes to the product projection. */
function entryText(entry: EntryRecord): string {
  const messages = entry.model ?? [];
  return messages
    .map((message) => {
      const content = message.content;
      if (!Array.isArray(content)) return content;
      return content.map((part) => (part.type === "text" ? part.text : "")).join("");
    })
    .join("");
}

/** Project one durable entry onto the wire. */
function wireEntry(entry: EntryRecord): LiveEntry {
  return { id: String(entry.id), kind: entry.kind, text: entryText(entry) };
}

/**
 * What one live connection needs from the Session for the chat's commands.
 *
 * @remarks
 * The socket is only a transport here: the send RPC and the abort RPC are the object's, and this
 * type is how the connection reaches them. `send` takes the client's own name for the turn and
 * uses it as the turn's request id, so the object sees the same id on a resend and the
 * conversation deduplicates it instead of running it twice.
 */
export interface LiveSendPort {
  /** Put one turn into a conversation; the code `null` means accepted. */
  send(
    conversationId: string,
    text: string,
    clientMessageId: string,
  ): Promise<
    | { readonly ok: true; readonly messageId: string }
    | { readonly ok: false; readonly code: LiveSendRejectionCode; readonly message: string }
  >;
  /** Stop the conversation's run; `null` means accepted. */
  abort(
    conversationId: string,
  ): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly code: LiveSendRejectionCode; readonly message: string }
  >;
}

/** One live connection: snapshot first, then appends and coalesced draft deltas. */
export class LiveConnection {
  readonly #socket: LiveSocket;
  readonly #conversationId: string;
  readonly #now: () => number;
  readonly #chat: LiveSendPort | undefined;
  readonly #batcher = new LiveDeltaBatcher();
  #latest: AgentLiveView | undefined;
  #lastEntryId = 0;
  #draft = "";
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  /** The sends this connection has not answered yet, by client id: a resend waits on the first. */
  readonly #inFlight = new Map<string, Promise<void>>();

  constructor(
    socket: LiveSocket,
    conversationId: string,
    options: {
      readonly now?: (() => number) | undefined;
      readonly chat?: LiveSendPort | undefined;
    } = {},
  ) {
    this.#socket = socket;
    this.#conversationId = conversationId;
    this.#now = options.now ?? Date.now;
    this.#chat = options.chat;
  }

  /**
   * Handle one client message; unknown or malformed input gets an error frame.
   *
   * @remarks
   * A `send` or `abort` is answered asynchronously: the object's RPC runs the turn, and the
   * answer (`accepted` / `rejected`) is written to this socket when it returns. A `send` whose
   * client id is already waiting is not repeated on this connection; the first one's answer is
   * this one's answer, because they name the same turn.
   */
  handleMessage(message: string | ArrayBuffer): void {
    if (this.#closed) return;
    let value: unknown;
    try {
      value = JSON.parse(
        message instanceof ArrayBuffer ? new TextDecoder().decode(message) : message,
      );
    } catch {
      this.#error("invalid_request", "The message is not JSON.");
      return;
    }
    let parsed: LiveClientMessage;
    try {
      parsed = parseLiveClientMessage(value);
    } catch {
      this.#error("invalid_request", "The message is not a live client message.");
      return;
    }
    switch (parsed.type) {
      case "ping":
        this.#send({ type: "pong", protocol: LIVE_PROTOCOL_VERSION });
        return;
      case "resync":
        if (this.#latest === undefined) {
          this.#error("unavailable", "The live view is not ready.");
          return;
        }
        this.#snapshot(this.#latest);
        return;
      case "send":
        this.#chatSend(parsed.conversationId, parsed.clientMessageId, parsed.text);
        return;
      case "abort":
        this.#chatAbort(parsed.conversationId);
        return;
      default: {
        const unhandled: never = parsed;
        throw new Error("unhandled live message: " + JSON.stringify(unhandled));
      }
    }
  }

  /**
   * The sends this connection has not answered yet.
   *
   * @internal
   * @remarks
   * A close waits on it, so an answer that is already decided reaches the socket before the
   * socket is gone; anything still running when the close happens stays unanswered, which is
   * what makes the client resend it.
   */
  get pending(): readonly Promise<void>[] {
    return [...this.#inFlight.values()];
  }

  /** Run one send and answer it; a resend of a pending send waits on the same answer. */
  #chatSend(conversationId: string, clientMessageId: string, text: string): void {
    const waiting = this.#inFlight.get(clientMessageId);
    if (waiting !== undefined) {
      void waiting;
      return;
    }
    const chat = this.#chat;
    if (chat === undefined) {
      this.#reject(clientMessageId, "unavailable", "The chat is not open on this connection.");
      return;
    }
    const answer = chat.send(conversationId, text, clientMessageId).then(
      (result) => {
        this.#inFlight.delete(clientMessageId);
        if (result.ok) {
          this.#send({
            type: "accepted",
            clientMessageId,
            messageId: result.messageId,
          } satisfies LiveAcceptedFrame);
          return;
        }
        this.#reject(clientMessageId, result.code, result.message);
      },
      () => {
        this.#inFlight.delete(clientMessageId);
        this.#reject(clientMessageId, "unavailable", "The turn could not be recorded.");
      },
    );
    this.#inFlight.set(clientMessageId, answer);
  }

  /**
   * Run one abort.
   *
   * @remarks
   * An abort has no answer of its own: what it changed reaches the client as the view the
   * object publishes, which is the one path every other change takes. A refused abort is a
   * typed error frame, because there is no message to put it beside.
   */
  #chatAbort(conversationId: string): void {
    const chat = this.#chat;
    if (chat === undefined) {
      this.#error("unavailable", "The chat is not open on this connection.");
      return;
    }
    void chat.abort(conversationId).then(
      (result) => {
        if (result.ok) return;
        // An absent conversation is the one refusal that has a live error code of its own; a
        // failed stop is `unavailable`, because a run that could not be stopped may still run.
        this.#error(
          result.code === "unknown_conversation" ? "not_found" : "unavailable",
          result.message,
        );
      },
      () => {
        this.#error("unavailable", "The run could not be stopped.");
      },
    );
  }

  #reject(clientMessageId: string, code: LiveSendRejectionCode, message: string): void {
    this.#send({ type: "rejected", clientMessageId, code, message } satisfies LiveRejectedFrame);
  }

  /** The conversation this connection follows. */
  get conversationId(): string {
    return this.#conversationId;
  }

  /** The newest durable entry sent to this client. */
  get cursor(): string {
    return String(this.#lastEntryId);
  }

  /**
   * Send the authoritative snapshot and remember it.
   *
   * @remarks
   * Every (re)connection starts here. A snapshot is idempotent for the client and closes any
   * gap a disconnection may have opened; appends and deltas only ever follow it.
   */
  start(view: AgentLiveView): void {
    this.#snapshot(view);
  }

  /** Apply one view revision: append durable entries before emitting draft text. */
  advance(view: AgentLiveView): void {
    if (this.#closed) return;
    this.#latest = view;
    const newest = liveCursorValue(liveCursorOf(view.entries));
    if (newest < this.#lastEntryId) {
      this.#snapshot(view);
      return;
    }
    if (newest > this.#lastEntryId) {
      const entries = view.entries
        .filter((entry) => Number(entry.id) > this.#lastEntryId)
        .map(wireEntry);
      this.#lastEntryId = newest;
      this.#send({
        type: "append",
        protocol: LIVE_PROTOCOL_VERSION,
        cursor: String(newest),
        conversationId: this.#conversationId,
        entries,
      });
      this.#saveAttachment();
    }
    this.#applyDraft(view.draft);
  }

  /** Stop timers and future sends. */
  close(): void {
    this.#closed = true;
    this.#clearFlush();
    this.#batcher.reset();
  }

  #snapshot(view: AgentLiveView): void {
    this.#latest = view;
    this.#lastEntryId = liveCursorValue(liveCursorOf(view.entries));
    this.#draft = view.draft;
    this.#clearFlush();
    this.#batcher.reset();
    this.#send({
      type: "snapshot",
      protocol: LIVE_PROTOCOL_VERSION,
      cursor: String(this.#lastEntryId),
      conversationId: this.#conversationId,
      title: view.conversation.title,
      entries: view.entries.map(wireEntry),
      draft: view.draft,
    });
    this.#saveAttachment();
  }

  #applyDraft(draft: string): void {
    if (draft === this.#draft) return;
    const previous = this.#draft;
    this.#draft = draft;
    if (draft.startsWith(previous)) {
      this.#pushDelta(draft.slice(previous.length));
      return;
    }
    this.#replaceDelta(draft);
  }

  #pushDelta(text: string): void {
    const frames = this.#batcher.push(text, this.#now());
    for (const frame of frames) this.#sendDelta(frame, false);
    this.#scheduleFlush();
  }

  #replaceDelta(text: string): void {
    this.#clearFlush();
    this.#batcher.reset();
    const chunks = chunkLiveText(text, LIVE_DELTA_MAX_BYTES);
    if (chunks.length === 0) {
      this.#sendDelta("", true);
      return;
    }
    chunks.forEach((chunk, index) => {
      this.#sendDelta(chunk, index === 0);
    });
  }

  #scheduleFlush(): void {
    if (this.#closed || this.#timer !== undefined || this.#batcher.pending === "") return;
    const delay = this.#batcher.delayUntil(this.#now());
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#flushDeltas();
    }, delay);
  }

  #flushDeltas(): void {
    const frames = this.#batcher.flush(this.#now());
    for (const frame of frames) this.#sendDelta(frame, false);
    if (this.#batcher.pending !== "") this.#scheduleFlush();
  }

  #clearFlush(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #sendDelta(text: string, replace: boolean): void {
    this.#send({
      type: "delta",
      protocol: LIVE_PROTOCOL_VERSION,
      conversationId: this.#conversationId,
      text,
      replace,
    });
  }

  #send(frame: LiveFrame | LiveSendResult): void {
    if (this.#closed) return;
    try {
      this.#socket.send(JSON.stringify(frame));
    } catch {
      this.close();
    }
  }

  #error(code: LiveErrorCode, message: string): void {
    this.#send({ type: "error", protocol: LIVE_PROTOCOL_VERSION, code, message });
  }

  #saveAttachment(): void {
    this.#socket.serializeAttachment?.({
      conversationId: this.#conversationId,
      cursor: String(this.#lastEntryId),
    } satisfies LiveAttachment);
  }
}

/**
 * Upgrade one request to a live conversation socket.
 *
 * @param options - The upgrade request, the DO socket host, a pair factory, and the Session.
 * @returns The 101 response and the live objects, or a typed problem response.
 *
 * @remarks
 * The conversation is checked before the upgrade, so an unknown id is a 404 rather than an
 * accepted socket that immediately errors. The initial snapshot is sent before the watch starts;
 * changes in between are queued by the watch and arrive as appends. A client `cursor` in the query
 * is accepted for correlation, but the snapshot is authoritative: the client never has to replay
 * its cursor to reconstruct the view.
 */
export async function openLiveSocket(options: {
  readonly request: Request;
  readonly host: LiveSocketHost;
  readonly pair: LiveSocketPairFactory;
  readonly session: AgentSession;
  /** The chat commands; absent means `send` and `abort` are answered `unavailable`. */
  readonly chat?: LiveSendPort | undefined;
  readonly now?: (() => number) | undefined;
  readonly upgradeResponse?: LiveUpgradeResponseFactory | undefined;
}): Promise<LiveUpgradeResult> {
  const path = new URL(options.request.url).pathname;
  if (!isWebSocketUpgrade(options.request)) {
    return err(problem("upgrade_required", "This route requires a WebSocket upgrade.", path));
  }
  const url = new URL(options.request.url);
  const query = v.safeParse(UpgradeQuerySchema, Object.fromEntries(url.searchParams));
  if (!query.success) {
    return err(problem("invalid_request", "conversationId must be a decimal id.", path));
  }
  const conversationId = query.output.conversationId;
  let conversation;
  try {
    conversation = await options.session.getConversation(conversationId);
  } catch {
    return err(problem("invalid_request", "conversationId must be a decimal id.", path));
  }
  if (conversation === undefined) {
    return err(problem("not_found", "No conversation has this id.", path));
  }

  let pair: LiveSocketPair;
  try {
    pair = options.pair();
  } catch {
    return err(problem("unavailable", "The WebSocket pair is unavailable.", path));
  }
  const client = pair[0];
  const server = pair[1];

  let watch: AgentLiveWatch;
  try {
    watch = await options.session.watchConversation(conversationId);
  } catch {
    return err(problem("unavailable", "The conversation cannot be watched.", path));
  }

  try {
    options.host.acceptWebSocket(server, [conversationId]);
  } catch {
    await watch.stop();
    return err(problem("unavailable", "The socket could not be accepted.", path));
  }
  const connection = new LiveConnection(server, conversationId, {
    now: options.now,
    chat: options.chat,
  });
  connection.start(watch.initial);
  watch.start((view) => {
    connection.advance(view);
  });
  const response = (options.upgradeResponse ?? defaultLiveUpgradeResponse)(client);
  return ok({ response, client, socket: server, connection, watch });
}
