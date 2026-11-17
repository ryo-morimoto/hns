import type { IncomingHttpHeaders } from "node:http";
import * as v from "valibot";
import {
  formatObsLog,
  isoTimestamp,
  ObsRequestIdSchema,
  obsPath,
  type ObsLogEntry,
} from "@hns/core";
import type { OperationName } from "./wire.ts";

/** Where one machine log line goes. */
export type MachineLogSink = (entry: ObsLogEntry) => void;

/** What one finished machine request logged. */
export interface MachineLogInput {
  /** The correlation id from the inbound header, or null when it was absent or malformed. */
  readonly requestId: string | null;
  /** The ROOT-relative file path, or the RPC path when no operation ran. */
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  /** The operation that ran, when the body was parsed. */
  readonly op?: OperationName | undefined;
  /** Epoch milliseconds. */
  readonly now: number;
}

/**
 * Read the correlation id from an inbound request.
 *
 * @param headers - The headers Node parsed.
 * @returns The id when it matches the edge's format, otherwise null.
 *
 * @remarks
 * The header is **not** part of the signed message (0147 signs machineId, connection, seq,
 * timestamp, nonce, method, path, and the body hash only), so it is never used for
 * authentication and a tampered id is not a refusal. The machine also never generates an id:
 * only the Worker's edge mints one.
 */
export function requestIdOf(headers: IncomingHttpHeaders): string | null {
  const raw = headers["x-request-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = v.safeParse(ObsRequestIdSchema, value);
  return parsed.success ? parsed.output : null;
}

/** The severity of one fs answer. */
function levelOfStatus(status: number): "info" | "warn" | "error" {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}

/**
 * Build the machine's fs hop entry.
 *
 * @param input - The request id, path, status, duration, operation, and clock.
 * @returns One entry in the same shape the server writes; no content, body, or token.
 *
 * @remarks
 * The path is the ROOT-relative path the operation named, not a host path, and it is reduced
 * to a pathname: a query string can never reach the line.
 */
export function machineEntry(input: MachineLogInput): ObsLogEntry {
  return {
    v: 1,
    at: isoTimestamp(new Date(input.now).toISOString()),
    level: levelOfStatus(input.status),
    event: "fs.op",
    hop: "fs",
    requestId: input.requestId,
    path: obsPath(input.path),
    status: input.status,
    durationMs: input.durationMs,
    detail: input.op === undefined ? undefined : { op: input.op },
  };
}

/**
 * The default sink: one JSON line per event on stderr.
 *
 * @param entry - The entry to write.
 * @returns Nothing.
 *
 * @remarks
 * A line is written whole, so a reader never sees half of one. stderr is used because stdout
 * carries the agent's operational output.
 */
export function writeMachineLog(entry: ObsLogEntry): void {
  process.stderr.write(formatObsLog(entry) + "\n");
}
