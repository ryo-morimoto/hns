import type { AgentEvent } from "@hns/agent";
import { isoTimestamp, levelOfStatus, obsPath, type ObsLogEntry } from "@hns/core";

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
