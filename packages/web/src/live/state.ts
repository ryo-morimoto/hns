import { EMPTY_LIVE_CURSOR, type LiveEntry, type LiveFrame } from "@hns/core";

/** The connection states a live view can be in, and the shell can display. */
export type ConnectionState = "connecting" | "online" | "reconnecting" | "offline";

/** The labels the shell shows; they are the visible contract. */
export const CONNECTION_LABELS: Record<ConnectionState, string> = {
  connecting: "接続中",
  online: "接続済み",
  reconnecting: "再接続中",
  offline: "未接続",
};

/** One conversation's client-side live state. */
export interface LiveConversationState {
  readonly status: ConnectionState;
  /** The snapshot window plus every append received since. */
  readonly entries: readonly LiveEntry[];
  /** The in-flight answer; replaced by a delta with `replace`, otherwise appended. */
  readonly draft: string;
  /** The newest durable entry the client has. Sent when reconnecting. */
  readonly cursor: string;
  /** Reconnect attempts since the connection was last healthy. */
  readonly attempt: number;
  /** The last typed failure, for the UI explanation; cleared by the next healthy frame. */
  readonly error: string | null;
}

/** The state before the first socket opens. */
export function initialLiveState(): LiveConversationState {
  return {
    status: "connecting",
    entries: [],
    draft: "",
    cursor: EMPTY_LIVE_CURSOR,
    attempt: 0,
    error: null,
  };
}

/** Sort entries by the decimal pi-durable id. */
function byId(left: LiveEntry, right: LiveEntry): number {
  return Number(left.id) - Number(right.id);
}

/**
 * Apply one parsed server frame.
 *
 * @param state - The current client state.
 * @param frame - A frame the protocol accepted.
 * @returns The next state; the input is not mutated.
 *
 * @remarks
 * A snapshot is authoritative and replaces the window: the server sends one on every connection,
 * so a reconnect cannot leave stale entries. An append is merged by id, so a duplicated frame is
 * harmless. A delta never changes the cursor: the answer is not durable until its entry arrives.
 */
export function applyLiveFrame(
  state: LiveConversationState,
  frame: LiveFrame,
): LiveConversationState {
  switch (frame.type) {
    case "snapshot":
      return {
        ...state,
        status: "online",
        entries: [...frame.entries].sort(byId),
        draft: frame.draft,
        cursor: frame.cursor,
        attempt: 0,
        error: null,
      };
    case "append": {
      const merged = new Map(state.entries.map((entry) => [entry.id, entry]));
      for (const entry of frame.entries) merged.set(entry.id, entry);
      return {
        ...state,
        status: "online",
        entries: [...merged.values()].sort(byId),
        cursor: frame.cursor,
        error: null,
      };
    }
    case "delta":
      return {
        ...state,
        status: "online",
        draft: frame.replace ? frame.text : state.draft + frame.text,
        error: null,
      };
    case "pong":
      return { ...state, status: "online", error: null };
    case "error":
      return { ...state, error: frame.message };
    default: {
      const unhandled: never = frame;
      throw new Error("unhandled live frame: " + JSON.stringify(unhandled));
    }
  }
}

/** The label and sentence the shell shows for one state. */
export interface ConnectionExplanation {
  readonly label: string;
  readonly detail: string;
}

/**
 * The human explanation of a connection state.
 *
 * @remarks
 * The reconnect detail names the attempt so a user can tell a blip from a dead connection; the
 * offline detail tells them the only action that resumes it.
 */
export function explainConnection(state: LiveConversationState): ConnectionExplanation {
  switch (state.status) {
    case "connecting":
      return { label: CONNECTION_LABELS.connecting, detail: "ライブ更新に接続しています。" };
    case "online":
      return { label: CONNECTION_LABELS.online, detail: "ライブ更新を受信しています。" };
    case "reconnecting":
      return {
        label: CONNECTION_LABELS.reconnecting,
        detail: "接続が切れました。" + String(state.attempt) + "回目の再接続を試みています。",
      };
    case "offline":
      return {
        label: CONNECTION_LABELS.offline,
        detail: state.error ?? "ライブ更新は停止しています。再読み込みすると再開します。",
      };
    default: {
      const unhandled: never = state.status;
      throw new Error("unhandled connection state: " + JSON.stringify(unhandled));
    }
  }
}
