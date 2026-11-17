import * as v from "valibot";
import { IsoTimestampSchema, type IsoTimestamp } from "./codecs.ts";
import { EVENT_LEVELS, EVENT_NAMES, type EventLevel, type EventName } from "./types.ts";

/**
 * The hops one request crosses, in the order it crosses them.
 *
 * @remarks
 * The list is the vocabulary, not a traversal: a request that is refused at the edge never
 * reaches `do`, `agent`, or `fs`. `browser` is the origin when the client reuses a request id;
 * a hop a request never reached has no entry.
 */
export const OBS_HOPS = ["browser", "worker", "do", "agent", "fs"] as const;
/** One hop of a request. */
export type ObsHop = (typeof OBS_HOPS)[number];

/**
 * The detail keys a log line may carry.
 *
 * @remarks
 * An allowlist, so a caller cannot persist a body, a header, or a token by putting one in
 * `detail`. Values stay primitive: identifiers, codes, counts, and flags only.
 */
export const OBS_DETAIL_KEYS = [
  "tool",
  "op",
  "ok",
  "code",
  "conversationId",
  "runId",
  "bytes",
] as const;
/** One allowed detail key. */
export type ObsDetailKey = (typeof OBS_DETAIL_KEYS)[number];
/**
 * The severity a hop records for one HTTP status.
 *
 * @param status - The status the hop answered with.
 * @returns `error` from 500, `warn` from 400, otherwise `info`.
 *
 * @remarks
 * The worker, the Durable Object, and the machine all classify a status this way, so one
 * definition keeps the three logs comparable.
 */
export function levelOfStatus(status: number): EventLevel {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}

/** One detail value: an identifier, code, count, or flag. */
export type ObsDetailValue = string | number | boolean | null;
/** The allowlisted detail of one log line. */
export type ObsDetail = {
  readonly [K in ObsDetailKey]?: ObsDetailValue | undefined;
};

/** How long one event is kept. */
export const OBS_RETENTION_DAYS = 30;
/** The most events one workspace keeps; the oldest are deleted first. */
export const OBS_MAX_EVENTS = 5_000;
/** The largest page `/api/events` returns. */
export const OBS_MAX_QUERY_LIMIT = 500;
/** The longest path a line keeps, in characters. */
export const OBS_MAX_PATH_LENGTH = 512;

/**
 * The wire rule for a correlation id.
 *
 * @remarks
 * Reuses the request id contract of the edge: printable ASCII, 1 to 128 characters. The id is
 * for logs only; it carries no authorization.
 */
export const OBS_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

/** The valibot schema for a correlation id. */
export const ObsRequestIdSchema: v.GenericSchema<unknown, string> = v.pipe(
  v.string(),
  v.regex(OBS_REQUEST_ID_PATTERN, "requestId must be 1-128 characters of [A-Za-z0-9._:-]"),
);

/**
 * One line of the observability log.
 *
 * @remarks
 * The same shape is written by the server (Durable Object) and the machine agent, so one reader
 * and one command can order both. The fields are the contract: a line never carries a body, a
 * header, or a token. `requestId` is null only for work that did not arrive through a request.
 */
export interface ObsLogEntry {
  /** The format version; a reader refuses anything else. */
  readonly v: 1;
  /** When the hop observed the work, ISO 8601 (UTC). */
  readonly at: IsoTimestamp;
  readonly level: EventLevel;
  readonly event: EventName;
  readonly hop: ObsHop;
  /** The correlation id of the request, or null when the work is not request-scoped. */
  readonly requestId: string | null;
  /** The pathname only; a query string and a fragment are never recorded. */
  readonly path?: string | undefined;
  /** The HTTP status of the hop's answer. */
  readonly status?: number | undefined;
  /** Elapsed milliseconds, when the hop measured work. */
  readonly durationMs?: number | undefined;
  /** Allowlisted detail; unknown keys are dropped when the line is written. */
  readonly detail?: ObsDetail | undefined;
}

const DetailValueSchema = v.union([v.string(), v.number(), v.boolean(), v.null()]);

/** The allowed detail keys, each optional; derived from {@link OBS_DETAIL_KEYS}. */
const DetailSchema: v.GenericSchema<unknown, ObsDetail> = v.object(
  Object.fromEntries(OBS_DETAIL_KEYS.map((key) => [key, v.optional(DetailValueSchema)])),
);

/**
 * The schema for one log line.
 *
 * @remarks
 * `v.object` drops unknown keys, so a line written with extra fields still parses into the
 * allowlisted shape. An unknown hop, event, or level is a `ValiError`: a stored value outside
 * the vocabulary is corruption, not a default.
 */
export const ObsLogEntrySchema: v.GenericSchema<unknown, ObsLogEntry> = v.object({
  v: v.literal(1),
  at: IsoTimestampSchema,
  level: v.picklist(EVENT_LEVELS),
  event: v.picklist(EVENT_NAMES),
  hop: v.picklist(OBS_HOPS),
  requestId: v.nullable(ObsRequestIdSchema),
  path: v.optional(v.pipe(v.string(), v.maxLength(OBS_MAX_PATH_LENGTH))),
  status: v.optional(v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599))),
  durationMs: v.optional(v.pipe(v.number(), v.minValue(0))),
  detail: v.optional(DetailSchema),
});

/**
 * Parse one log line from untrusted text.
 *
 * @param input - The JSON value of a line.
 * @returns The allowlisted entry.
 * @throws {v.ValiError} When the line is not the log format or names an unknown member.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the JSON boundary: the line is untrusted until the schema runs here.
export function parseObsLog(input: unknown): ObsLogEntry {
  return v.parse(ObsLogEntrySchema, input);
}

/** The line a formatter builds, with the allowlisted keys only. */
interface ObsLogLine {
  v: 1;
  at: IsoTimestamp;
  level: EventLevel;
  event: EventName;
  hop: ObsHop;
  requestId: string | null;
  path?: string | undefined;
  status?: number | undefined;
  durationMs?: number | undefined;
  detail?: ObsDetail | undefined;
}

/**
 * Format one entry as a JSON line.
 *
 * @param entry - The entry to write.
 * @returns One line, with the allowlisted keys in a stable order and no trailing newline.
 *
 * @remarks
 * The value is parsed again before writing, so a runtime object that carries extra fields cannot
 * put them on the line. Detail is written only for the allowlisted keys.
 */
export function formatObsLog(entry: ObsLogEntry): string {
  const clean = parseObsLog(entry);
  const line: ObsLogLine = {
    v: clean.v,
    at: clean.at,
    level: clean.level,
    event: clean.event,
    hop: clean.hop,
    requestId: clean.requestId,
  };
  if (clean.path !== undefined) line.path = clean.path;
  if (clean.status !== undefined) line.status = clean.status;
  if (clean.durationMs !== undefined) line.durationMs = clean.durationMs;
  if (clean.detail !== undefined) line.detail = clean.detail;
  return JSON.stringify(line);
}

/**
 * Reduce an arbitrary URL or path to the pathname only.
 *
 * @param value - A URL, an absolute path, or a relative path.
 * @returns The pathname, capped at {@link OBS_MAX_PATH_LENGTH}. A value that cannot be parsed
 * becomes `/`.
 *
 * @remarks
 * Query strings and fragments are dropped here, so a token in `?token=...` never reaches a line.
 */
export function obsPath(value: string): string {
  let pathname: string;
  try {
    pathname = new URL(value, "https://hns.invalid").pathname;
  } catch {
    pathname = "/";
  }
  return pathname.slice(0, OBS_MAX_PATH_LENGTH);
}

/** One HTTP status and how many responses had it. */
export interface ObsStatusCount {
  readonly status: number;
  readonly count: number;
}

/** One hop and how many events it wrote. */
export interface ObsHopCount {
  readonly hop: ObsHop;
  readonly count: number;
}

/** One event name and how many times it occurred. */
export interface ObsEventCount {
  readonly event: EventName;
  readonly count: number;
}

/**
 * The aggregate `/api/metrics` returns.
 *
 * @remarks
 * The window is the last 24 hours. `stored`, `retentionDays`, and `maxEvents` describe the log
 * itself, so a reader can see retention from the same response. Workflow, firing, and usage
 * totals are not here: they live in the issues that own those records.
 */
export interface ObsMetrics {
  /** The measurement window, in milliseconds. */
  readonly windowMs: number;
  readonly http: {
    readonly total: number;
    readonly byStatus: readonly ObsStatusCount[];
    readonly p50ms: number;
    readonly p95ms: number;
  };
  readonly byHop: readonly ObsHopCount[];
  /** Events at `error` level in the window. */
  readonly errors: number;
  /** `tool.call` events in the window. */
  readonly toolCalls: number;
  /** `tool.result` events logged at warn or error in the window. */
  readonly toolErrors: number;
  /** `agent.response` events in the window. */
  readonly agentResponses: number;
  /** The busiest event names in the window, descending, at most 25. */
  readonly byEvent: readonly ObsEventCount[];
  /** Rows stored now. */
  readonly stored: number;
  /** The configured retention in days. */
  readonly retentionDays: number;
  /** The configured event cap. */
  readonly maxEvents: number;
}
