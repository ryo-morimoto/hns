import type { AgentEvent } from "@hns/agent";
import {
  isoTimestamp,
  levelOfStatus,
  obsPath,
  type EventLevel,
  type EventName,
  type IsoTimestamp,
  type ObsLogEntry,
} from "@hns/core";

/** The facts of one finished HTTP request. */
export interface HttpEventInput {
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  /** Epoch milliseconds; tests pass a fixed clock. */
  readonly now: number;
}

/**
 * Build the worker hop's entry for one finished request.
 *
 * @param input - The request id, method, pathname, status, duration, and clock.
 * @returns One entry with no query string, body, header, or token.
 */
export function httpEntry(input: HttpEventInput): ObsLogEntry {
  return {
    v: 1,
    at: isoTimestamp(new Date(input.now).toISOString()),
    level: levelOfStatus(input.status),
    event: input.status >= 500 ? "http.error" : "http",
    hop: "worker",
    requestId: input.requestId,
    path: obsPath(input.path),
    status: input.status,
    durationMs: input.durationMs,
    detail: { tool: input.method },
  };
}

/**
 * Build the Durable Object hop's entry for one internal RPC.
 *
 * @param requestId - The correlation id of the forwarded request.
 * @param path - The RPC pathname.
 * @param status - The status the object answered with.
 * @param durationMs - The object's elapsed time.
 * @param now - Epoch milliseconds.
 * @returns One entry with the RPC path only.
 */
export function doEntry(
  requestId: string,
  path: string,
  status: number,
  durationMs: number,
  now: number,
): ObsLogEntry {
  return {
    v: 1,
    at: isoTimestamp(new Date(now).toISOString()),
    level: levelOfStatus(status),
    event: "do.rpc",
    hop: "do",
    requestId,
    path: obsPath(path),
    status,
    durationMs,
  };
}

/** What one index observation reports. Every field is an id, a count, or a closed code. */
export interface IndexEntryInput {
  /** The event name; the index names are members of `EVENT_NAMES`. */
  readonly event: EventName;
  /** The correlation id of the request that triggered it; null for work no request triggered. */
  readonly requestId: string | null;
  /** When the hop observed it, ISO 8601 (UTC). */
  readonly at: IsoTimestamp;
  readonly level: EventLevel;
  /** The conversation the drain stopped at, when it names one. */
  readonly conversationId?: string | undefined;
  /** The drain attempt count, as the object counts it. */
  readonly attempt?: number | undefined;
  /** The failure code recorded in `index_state`; only a failed drain carries one. */
  readonly code?: string | undefined;
  /** Rows the drain left waiting. */
  readonly pending?: number | undefined;
  /** Rows a rebuild wrote. */
  readonly indexed?: number | undefined;
  /** Rows a rebuild removed. */
  readonly removed?: number | undefined;
  /** Rows a drain found under an older object's metadata. */
  readonly rows?: number | undefined;
}

/**
 * Build the Session hop's entry for one index observation.
 *
 * @param input - The event, the correlation id, the clock, and the facts of that event.
 * @returns One `ObsLogEntry` with the allowlisted detail keys only.
 *
 * @remarks
 * The detail allowlist is `OBS_DETAIL_KEYS`; a fact with no key there (the error's name) is not
 * written, so a line cannot grow a second, unchecked channel.
 *
 * @remarks
 * The index used to write its own JSON under names the log did not know; every line now goes
 * through the same entry the worker and the object write, so a reader parses one shape and an
 * unknown name fails the same way on write and on read.
 */
export function indexEntry(input: IndexEntryInput): ObsLogEntry {
  const detail: Record<string, string | number> = {};
  if (input.conversationId !== undefined) detail.conversationId = input.conversationId;
  if (input.attempt !== undefined) detail.attempt = input.attempt;
  if (input.code !== undefined) detail.code = input.code;
  if (input.pending !== undefined) detail.pending = input.pending;
  if (input.indexed !== undefined) detail.indexed = input.indexed;
  if (input.removed !== undefined) detail.removed = input.removed;
  if (input.rows !== undefined) detail.rows = input.rows;
  const entry: ObsLogEntry = {
    v: 1,
    at: input.at,
    level: input.level,
    event: input.event,
    hop: "do",
    requestId: input.requestId,
  };
  return Object.keys(detail).length === 0 ? entry : { ...entry, detail };
}

/**
 * Convert one agent observation into a log entry.
 *
 * @param event - The event the agent emitted.
 * @returns The entry; `agent.response` carries only ids and the event name, never the text.
 *
 * @remarks
 * The response text is the model output and may hold user data, so it is dropped here. A tool
 * event keeps the tool name, success, and duration; the arguments and the output never reached
 * the sink.
 */
export function agentEntry(event: AgentEvent): ObsLogEntry {
  const requestId = event.requestId ?? null;
  const conversationId =
    event.conversationId === undefined ? undefined : { conversationId: event.conversationId };
  switch (event.event) {
    case "agent.response": {
      const entry: ObsLogEntry = {
        v: 1,
        at: isoTimestamp(event.at),
        level: "info",
        event: "agent.response",
        hop: "agent",
        requestId,
      };
      return conversationId === undefined ? entry : { ...entry, detail: conversationId };
    }
    case "tool.call":
      return {
        v: 1,
        at: isoTimestamp(event.at),
        level: "info",
        event: "tool.call",
        hop: "agent",
        requestId,
        detail: { tool: event.tool, ...conversationId },
      };
    case "tool.result":
      return {
        v: 1,
        at: isoTimestamp(event.at),
        level: event.ok ? "info" : "warn",
        event: "tool.result",
        hop: "agent",
        requestId,
        durationMs: event.ms,
        detail: { tool: event.tool, ok: event.ok, ...conversationId },
      };
    default: {
      const unhandled: never = event;
      throw new Error("unknown agent event: " + String(unhandled));
    }
  }
}