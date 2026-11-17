import type { IncomingHttpHeaders } from "node:http";
import * as v from "valibot";
import {
  formatObsLog,
  isoTimestamp,
  levelOfStatus,
  ObsRequestIdSchema,
  obsPath,
  parseObsLog,
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
 * authentication and a tampered id is not a refusal. The machine never generates one: the
 * edge mints the HTTP correlation id, and an internal runtime that omits it gets its own turn
 * id. A missing header is logged as null.
 */
export function requestIdOf(headers: IncomingHttpHeaders): string | null {
  const raw = headers["x-request-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = v.safeParse(ObsRequestIdSchema, value);
  return parsed.success ? parsed.output : null;
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

/** What a redaction replaces a secret with in text the agent is about to write. */
export const REDACTED = "***";

/**
 * Build a sink that never writes a secret.
 *
 * @param sink - The sink to write to after redaction.
 * @param secrets - The values that must not appear; empty and undefined values are ignored.
 * @returns A sink whose every line has each secret replaced before it is formatted and written.
 *
 * @remarks
 * The log entry is an allowlisted shape, so a secret cannot arrive as a field. This guard covers
 * the other route: a secret that a message, a path, or a future field carried as text. The
 * replacement runs on the stringified entry rather than on its fields, so a nested detail value
 * is covered too. A secret of one character would redact almost everything, so values shorter
 * than four characters are ignored; a real token is far longer.
 *
 * @internal
 */
export function redactingSink(
  sink: MachineLogSink,
  secrets: readonly (string | undefined)[],
): MachineLogSink {
  const known = secrets.filter(
    (secret): secret is string => secret !== undefined && secret.length >= 4,
  );
  if (known.length === 0) return sink;
  return (entry) => {
    // The redaction runs on the formatted line: that JSON is the one place every allowlisted
    // field's text is, and the parse below returns it to the entry shape the sink writes.
    let text = formatObsLog(entry);
    for (const secret of known) text = text.split(secret).join(REDACTED);
    sink(parseObsLog(JSON.parse(text)));
  };
}
