/* oxlint-disable anti-slop/no-unknown-parameters --
   The two parse functions at the end are the wire boundary: they take JSON and return the
   closed frame union.
*/
import * as v from "valibot";

/**
 * The live-update wire protocol version.
 *
 * @remarks
 * A frame of another version is refused instead of guessed, so a client and the Session DO
 * fail as a protocol mismatch rather than half-updating a screen.
 */
export const LIVE_PROTOCOL_VERSION = 1;

/**
 * The closed vocabulary of server-to-client frames.
 *
 * @remarks
 * Adding a member is a protocol change: the client's exhaustive switch and the valibot variant
 * must both learn it. There is no "unknown frame" fallback.
 */
export const LIVE_FRAME_TYPES = ["snapshot", "append", "delta", "pong", "error"] as const;
/** One server-to-client frame kind. */
export type LiveFrameType = (typeof LIVE_FRAME_TYPES)[number];

/** The closed failure vocabulary a live error frame carries. */
export const LIVE_ERROR_CODES = [
  "invalid_request",
  "not_found",
  "unavailable",
  "internal",
] as const;
/** One live failure code. */
export type LiveErrorCode = (typeof LIVE_ERROR_CODES)[number];

/** The closed vocabulary of client-to-server messages. */
export const LIVE_CLIENT_MESSAGE_TYPES = ["ping", "resync"] as const;
/** One client-to-server message kind. */
export type LiveClientMessageType = (typeof LIVE_CLIENT_MESSAGE_TYPES)[number];

/** The cursor before any durable entry; entry ids start at 1. */
export const EMPTY_LIVE_CURSOR = "0";

/** How often token deltas are folded into one frame. */
export const LIVE_DELTA_INTERVAL_MS = 100;
/** The largest text one delta frame carries. */
export const LIVE_DELTA_MAX_BYTES = 64 * 1024;

/**
 * One transcript entry as the live face sends it.
 *
 * @remarks
 * This is the product projection, not pi-durable's record: the UI needs an id to deduplicate,
 * the kind to group, and the text to render. Internal fields such as `byTaskId` stay in the DO.
 */
export interface LiveEntry {
  /** Decimal pi-durable entry id; monotonically increasing within a conversation. */
  readonly id: string;
  /** Entry kind, such as `pi.user`, `pi.assistant`, or a tool entry. */
  readonly kind: string;
  /** Text the entry contributes; empty when it only carries a tool call. */
  readonly text: string;
}

/** The first frame of every connection: the authoritative current view. */
export interface LiveSnapshotFrame {
  readonly type: "snapshot";
  readonly protocol: typeof LIVE_PROTOCOL_VERSION;
  /** The newest durable entry the snapshot includes, or {@link EMPTY_LIVE_CURSOR}. */
  readonly cursor: string;
  readonly conversationId: string;
  readonly title: string;
  /** The watched window, oldest first. */
  readonly entries: readonly LiveEntry[];
  /** Text of the in-flight assistant answer; empty when nothing is being generated. */
  readonly draft: string;
}

/** Durable entries committed since the previous frame. */
export interface LiveAppendFrame {
  readonly type: "append";
  readonly protocol: typeof LIVE_PROTOCOL_VERSION;
  /** The newest entry this frame includes. */
  readonly cursor: string;
  readonly conversationId: string;
  /** New entries, oldest first. */
  readonly entries: readonly LiveEntry[];
}

/** A throttled piece of the in-flight assistant answer. */
export interface LiveDeltaFrame {
  readonly type: "delta";
  readonly protocol: typeof LIVE_PROTOCOL_VERSION;
  readonly conversationId: string;
  /**
   * Text to add, or the whole draft when `replace` is true.
   *
   * @remarks
   * A delta never advances the cursor: the answer is not durable until the assistant entry is
   * committed, and a reconnect replaces the draft from a fresh snapshot.
   */
  readonly text: string;
  /** True when this frame replaces the client's draft instead of appending to it. */
  readonly replace: boolean;
}

/** Acknowledgement of a client ping; also keeps a hibernating object awake. */
export interface LivePongFrame {
  readonly type: "pong";
  readonly protocol: typeof LIVE_PROTOCOL_VERSION;
}

/** A typed failure the connection survives; the client may resync. */
export interface LiveErrorFrame {
  readonly type: "error";
  readonly protocol: typeof LIVE_PROTOCOL_VERSION;
  readonly code: LiveErrorCode;
  readonly message: string;
}

/** One server-to-client frame. The union is closed. */
export type LiveFrame =
  | LiveSnapshotFrame
  | LiveAppendFrame
  | LiveDeltaFrame
  | LivePongFrame
  | LiveErrorFrame;

/** One client-to-server message. */
export type LiveClientMessage = { readonly type: "ping" } | { readonly type: "resync" };

const IdSchema = v.pipe(
  v.string(),
  v.regex(/^[1-9][0-9]*$/u),
  v.check((value) => Number.isSafeInteger(Number(value)), "entry id is out of range"),
);

const CursorSchema = v.pipe(
  v.string(),
  v.regex(/^(0|[1-9][0-9]*)$/u),
  v.check((value) => Number.isSafeInteger(Number(value)), "cursor is out of range"),
);

const LiveEntrySchema = v.object({
  id: IdSchema,
  kind: v.pipe(v.string(), v.minLength(1)),
  text: v.string(),
});

const SnapshotSchema = v.object({
  type: v.literal("snapshot"),
  protocol: v.literal(LIVE_PROTOCOL_VERSION),
  cursor: CursorSchema,
  conversationId: v.pipe(v.string(), v.minLength(1)),
  title: v.string(),
  entries: v.array(LiveEntrySchema),
  draft: v.string(),
});

const AppendSchema = v.object({
  type: v.literal("append"),
  protocol: v.literal(LIVE_PROTOCOL_VERSION),
  cursor: CursorSchema,
  conversationId: v.pipe(v.string(), v.minLength(1)),
  entries: v.array(LiveEntrySchema),
});

const DeltaSchema = v.object({
  type: v.literal("delta"),
  protocol: v.literal(LIVE_PROTOCOL_VERSION),
  conversationId: v.pipe(v.string(), v.minLength(1)),
  text: v.string(),
  replace: v.boolean(),
});

const PongSchema = v.object({
  type: v.literal("pong"),
  protocol: v.literal(LIVE_PROTOCOL_VERSION),
});

const ErrorSchema = v.object({
  type: v.literal("error"),
  protocol: v.literal(LIVE_PROTOCOL_VERSION),
  code: v.picklist(LIVE_ERROR_CODES),
  message: v.string(),
});

/**
 * The runtime shape of a live frame.
 *
 * @remarks
 * `v.variant` picks the member by `type`, so an unknown type or an extra field that changes a
 * member's meaning fails rather than being silently ignored. The protocol literal pins the
 * version.
 */
export const LiveFrameSchema = v.variant("type", [
  SnapshotSchema,
  AppendSchema,
  DeltaSchema,
  PongSchema,
  ErrorSchema,
]);

/** The runtime shape of a client message. */
export const LiveClientMessageSchema = v.variant("type", [
  v.object({ type: v.literal("ping") }),
  v.object({ type: v.literal("resync") }),
]);

/**
 * Parse one live frame received from the network.
 *
 * @param value - Untrusted JSON.
 * @returns The frame, narrowed to {@link LiveFrame}.
 * @throws ValiError when the value is not a frame of this protocol.
 */
export function parseLiveFrame(value: unknown): LiveFrame {
  return v.parse(LiveFrameSchema, value);
}

/**
 * Parse one client message.
 *
 * @param value - Untrusted JSON.
 * @returns The message.
 * @throws ValiError when the value is not a client message.
 */
export function parseLiveClientMessage(value: unknown): LiveClientMessage {
  return v.parse(LiveClientMessageSchema, value);
}

/**
 * The numeric value of a cursor.
 *
 * @param cursor - A decimal entry id, or {@link EMPTY_LIVE_CURSOR}.
 * @returns The id as a non-negative safe integer.
 * @throws Error when the cursor is malformed; callers validate before trusting it.
 */
export function liveCursorValue(cursor: string): number {
  const parsed = v.safeParse(CursorSchema, cursor);
  if (!parsed.success) throw new Error("invalid live cursor: " + cursor);
  return Number(parsed.output);
}

/**
 * The newest entry id in a page, as a cursor.
 *
 * @param entries - Entries in any order; only `id` is read.
 * @returns The decimal id of the newest entry, or {@link EMPTY_LIVE_CURSOR}.
 * @throws Error when an id is not a positive safe integer. Stored ids are trusted, so this is
 * an invariant violation rather than an input error.
 */
export function liveCursorOf(entries: readonly { readonly id: string | number }[]): string {
  let newest = 0;
  for (const entry of entries) {
    const id = liveCursorValue(String(entry.id));
    if (id > newest) newest = id;
  }
  return String(newest);
}

/** The UTF-8 byte length of one code point. */
function codePointBytes(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code <= 0x7f) return 1;
  if (code <= 0x7ff) return 2;
  if (code <= 0xffff) return 3;
  return 4;
}

/** The UTF-8 byte length of a string. */
function textBytes(text: string): number {
  let bytes = 0;
  for (const char of text) bytes += codePointBytes(char);
  return bytes;
}

/**
 * Split text into chunks no larger than `maxBytes` of UTF-8.
 *
 * @param text - Text to split. A single code point larger than `maxBytes` is kept whole.
 * @param maxBytes - Positive integer; at least 1.
 * @returns Non-empty chunks in order; `[]` for an empty string.
 * @throws RangeError when `maxBytes` is not a positive integer.
 */
export function chunkLiveText(text: string, maxBytes: number): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive integer");
  }
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of text) {
    const size = codePointBytes(char);
    if (bytes + size > maxBytes && current !== "") {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

/** Options for {@link LiveDeltaBatcher}. */
export interface LiveDeltaBatcherOptions {
  /** Minimum pause between frames; defaults to {@link LIVE_DELTA_INTERVAL_MS}. */
  readonly intervalMs?: number | undefined;
  /** Maximum text per frame; defaults to {@link LIVE_DELTA_MAX_BYTES}. */
  readonly maxBytes?: number | undefined;
}

/**
 * Fold a stream of token deltas into bounded frames.
 *
 * @remarks
 * The source is the in-flight answer, which can change many times per second. Sending each change
 * would multiply DO requests and latency, so a batch is released when it has waited
 * `intervalMs` or when it reaches `maxBytes`. A batch that is already large is split so no frame
 * exceeds `maxBytes`. The batcher is synchronous and clock-injected: the caller passes
 * `Date.now()` (or a fake in tests).
 */
export class LiveDeltaBatcher {
  readonly #intervalMs: number;
  readonly #maxBytes: number;
  #pending = "";
  #startedAt: number | undefined;

  constructor(options: LiveDeltaBatcherOptions = {}) {
    const intervalMs = options.intervalMs ?? LIVE_DELTA_INTERVAL_MS;
    const maxBytes = options.maxBytes ?? LIVE_DELTA_MAX_BYTES;
    if (!Number.isInteger(intervalMs) || intervalMs < 1) {
      throw new RangeError("intervalMs must be a positive integer");
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError("maxBytes must be a positive integer");
    }
    this.#intervalMs = intervalMs;
    this.#maxBytes = maxBytes;
  }

  /** Text waiting for the next frame. */
  get pending(): string {
    return this.#pending;
  }

  /** The configured interval. */
  get intervalMs(): number {
    return this.#intervalMs;
  }

  /** Add text; returns the frames that are due now. */
  push(text: string, at: number): readonly string[] {
    if (text === "") return [];
    if (this.#pending === "") this.#startedAt = at;
    this.#pending += text;
    return this.#drain(at, false);
  }

  /** Release everything pending now, regardless of the interval. */
  flush(at: number): readonly string[] {
    return this.#drain(at, true);
  }

  /** Drop pending text; a replacement supersedes it. */
  reset(): void {
    this.#pending = "";
    this.#startedAt = undefined;
  }

  /**
   * Milliseconds until the pending text is due, or 0 when nothing is pending.
   *
   * @param at - Current epoch milliseconds.
   */
  delayUntil(at: number): number {
    if (this.#pending === "") return 0;
    const started = this.#startedAt ?? at;
    return Math.max(0, this.#intervalMs - (at - started));
  }

  #drain(at: number, force: boolean): string[] {
    if (this.#pending === "") return [];
    const started = this.#startedAt ?? at;
    const due = force || at - started >= this.#intervalMs;
    const overLimit = textBytes(this.#pending) > this.#maxBytes;
    if (!due && !overLimit) return [];
    const chunks = chunkLiveText(this.#pending, this.#maxBytes);
    this.#pending = "";
    this.#startedAt = undefined;
    return chunks;
  }
}
