import { EMPTY_LIVE_CURSOR, parseLiveFrame } from "@hns/core";
import { applyLiveFrame, initialLiveState, type LiveConversationState } from "./state.ts";

/** What the server sends on a text frame; the live protocol has no binary frame. */
interface LiveMessageEvent {
  readonly data: string;
}

/** A socket as the client uses it; tests implement this without a browser. */
export interface LiveSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: LiveMessageEvent) => void) | null;
  onclose: ((event: { readonly code?: number }) => void) | null;
  onerror: (() => void) | null;
}

/** Builds one socket for a URL; production uses the browser's WebSocket. */
export type LiveSocketFactory = (url: string) => LiveSocketLike;

/** Schedules a reconnect and returns the function that cancels it. */
type LiveReconnectSchedule = (run: () => void, ms: number) => () => void;

/** The delays before each reconnect attempt, then give up. */
export const LIVE_RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000] as const;

/** A live conversation controller; it is not tied to React so it can be unit-tested. */
export interface LiveClient {
  /** The latest state; a new object after every change. */
  readonly state: LiveConversationState;
  /** Stop reconnecting and close the socket. */
  close(): void;
  /** Start over now, clearing the attempt count. */
  retry(): void;
  /** Observe state changes; returns the unsubscribe function. */
  subscribe(listener: (state: LiveConversationState) => void): () => void;
}

/** Options for {@link createLiveClient}. */
export interface LiveClientOptions {
  readonly conversationId: string;
  readonly socket: LiveSocketFactory;
  /** Defaults to `/ws`. */
  readonly path?: string | undefined;
  /** Schedules a reconnect; tests inject a deterministic queue. */
  readonly schedule?: LiveReconnectSchedule | undefined;
}

/** Build the browser socket adapter, so the client can keep a small structural socket type. */
export function browserLiveSocket(url: string): LiveSocketLike {
  const socket = new WebSocket(url);
  const adapter: LiveSocketLike = {
    send: (data) => {
      socket.send(data);
    },
    close: () => {
      socket.close();
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  socket.onopen = () => {
    adapter.onopen?.();
  };
  socket.onmessage = (event) => {
    // SAFETY: the live protocol is text frames only; a binary frame is a protocol violation
    // and JSON.parse surfaces it as a typed client error.
    adapter.onmessage?.({ data: event.data as string });
  };
  socket.onclose = (event) => {
    adapter.onclose?.({ code: event.code });
  };
  socket.onerror = () => {
    adapter.onerror?.();
  };
  return adapter;
}

/** The reconnect URL: the current cursor lets the server correlate the resumed subscription. */
function socketUrl(path: string, conversationId: string, cursor: string): string {
  const params = new URLSearchParams({ conversationId });
  if (cursor !== EMPTY_LIVE_CURSOR) params.set("cursor", cursor);
  return path + "?" + params.toString();
}

/**
 * Open and maintain one conversation's live subscription.
 *
 * @param options - The conversation, a socket factory, and optional scheduling seams.
 * @returns A controller that connects immediately.
 *
 * @remarks
 * A close schedules the next attempt with the current cursor; the server answers a fresh
 * snapshot, so entries committed while away are not lost. After the last delay the state becomes
 * `offline` with an explanation instead of retrying forever. A protocol error keeps the socket
 * open (the next valid frame heals it) but is surfaced to the UI.
 */
export function createLiveClient(options: LiveClientOptions): LiveClient {
  const path = options.path ?? "/ws";
  const schedule: LiveReconnectSchedule =
    options.schedule ??
    ((run, ms) => {
      const timer = setTimeout(run, ms);
      return () => {
        clearTimeout(timer);
      };
    });

  let state = initialLiveState();
  let socket: LiveSocketLike | undefined;
  let cancelRetry: (() => void) | undefined;
  let closed = false;
  const listeners = new Set<(next: LiveConversationState) => void>();

  const publish = (next: LiveConversationState): void => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  const connect = (): void => {
    if (closed) return;
    cancelRetry = undefined;
    const nextSocket = options.socket(socketUrl(path, options.conversationId, state.cursor));
    socket = nextSocket;
    nextSocket.onopen = () => {
      if (socket !== nextSocket) return;
      cancelRetry?.();
      cancelRetry = undefined;
      publish({ ...state, status: "online", attempt: 0, error: null });
    };
    nextSocket.onmessage = (event) => {
      if (socket !== nextSocket) return;
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        publish({ ...state, error: "ライブ更新の形式が不正です。" });
        return;
      }
      try {
        publish(applyLiveFrame(state, parseLiveFrame(value)));
      } catch {
        publish({ ...state, error: "ライブ更新の形式が不正です。" });
      }
    };
    nextSocket.onclose = () => {
      if (socket !== nextSocket) return;
      socket = undefined;
      if (closed) return;
      const attempt = state.attempt + 1;
      if (attempt > LIVE_RECONNECT_DELAYS_MS.length) {
        publish({
          ...state,
          status: "offline",
          attempt,
          error: "接続が切れました。再読み込みすると再開します。",
        });
        return;
      }
      const delay = LIVE_RECONNECT_DELAYS_MS[attempt - 1] ?? 0;
      publish({ ...state, status: "reconnecting", attempt });
      cancelRetry = schedule(connect, delay);
    };
    nextSocket.onerror = () => {
      // Browsers follow an error with close; the close handler owns the retry.
    };
  };

  connect();

  return {
    get state() {
      return state;
    },
    close() {
      closed = true;
      cancelRetry?.();
      cancelRetry = undefined;
      const previous = socket;
      socket = undefined;
      previous?.close();
    },
    retry() {
      if (closed) return;
      cancelRetry?.();
      cancelRetry = undefined;
      const previous = socket;
      socket = undefined;
      previous?.close();
      publish({ ...state, status: "connecting", attempt: 0, error: null });
      connect();
    },
    subscribe(listener: (next: LiveConversationState) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
