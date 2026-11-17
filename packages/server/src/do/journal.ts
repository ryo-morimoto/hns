import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {
  IsoTimestampSchema,
  OperationIdSchema,
  isoTimestamp,
  type MutationResult,
  type OperationId,
} from "@hns/core";
import {
  JOURNAL_COLUMN_NAMES,
  JOURNAL_INLINE_BODY_MAX_BYTES,
  JOURNAL_SCHEMA,
  journalBodyKey,
  journalUpgradeStatements,
  parseJournalEntry,
  type JournalAuditEntry,
  type JournalBody,
  type JournalEntry,
  type JournalEventEntry,
  type JournalIntentEntry,
  type JournalKind,
  type JournalOutcomeEntry,
  type JournalWatermark,
} from "@hns/store";
import * as v from "valibot";
import type { WorkerEnv } from "../edge/env.ts";

/** Values the Durable Object SQL binding accepts and returns. */
type SqlValue = ArrayBuffer | string | number | null;
type Row = Record<string, SqlValue>;

/** The slice of the Durable Object storage the Journal uses. */
export type JournalStorage = Pick<DurableObjectSqliteStorage, "sql" | "transaction">;

/** The bucket operations the Journal calls, structurally narrowed from `env.OBJECTS`. */
export type JournalBucket = Pick<NonNullable<WorkerEnv["OBJECTS"]>, "put" | "get" | "head">;

/** Rows one read returns when the caller names no limit. */
const JOURNAL_READ_DEFAULT_LIMIT = 50;

/** The largest page a caller may ask for. A full read is not an option. */
export const JOURNAL_READ_MAX_LIMIT = 200;

/** Test seams for the clock and the object store. */
export interface JournalOptions {
  /** Milliseconds since the epoch; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** The bucket for bodies over 256KB; the Workspace DO passes `env.OBJECTS`. */
  readonly bucket?: JournalBucket | undefined;
}

/** What one intent append did. */
export type IntentAppend =
  | { readonly status: "appended"; readonly entry: JournalIntentEntry }
  | { readonly status: "pending"; readonly entry: JournalIntentEntry }
  | { readonly status: "settled"; readonly entry: JournalOutcomeEntry }
  | { readonly status: "denied"; readonly reason: "operation_id_reused" };

/** What one outcome append did. */
export type OutcomeAppend =
  | { readonly status: "appended"; readonly entry: JournalOutcomeEntry }
  | { readonly status: "settled"; readonly entry: JournalOutcomeEntry };

/** The input of {@link Journal.appendIntent}. */
export interface IntentAppendInput {
  /** The attempt's id; the same id may be retried, but never with different content. */
  readonly operationId: OperationId;
  /** The normalized workspace-relative path the write names. */
  readonly path: string;
  /** The version the writer saw. */
  readonly expectedVersion: string;
  /** The bytes to write. Over 256KB they go to the object store first. */
  readonly body?: Uint8Array | undefined;
}

/**
 * What a settle records: a `MutationResult`, or the Journal's own `denied`.
 *
 * @remarks
 * `denied` is not part of `MutationResult` (the application contract): it is how the Journal
 * settles an intent the machine refused before writing, so the intent is no longer pending and
 * a checkpoint may pass it. `reason` is the machine's refusal code.
 */
type JournalOutcomeInput =
  | MutationResult
  | {
      readonly status: "denied";
      readonly operationId: OperationId;
      readonly reason: string;
    };

/** The input of {@link Journal.appendOutcome}. */
export interface OutcomeAppendInput {
  /** The path the intent named; it must match. */
  readonly path: string;
  /** The result to record; its `operationId` names the intent. */
  readonly result: JournalOutcomeInput;
}

/** The input of {@link Journal.appendAudit}. */
export interface AuditAppendInput {
  /** The attempt's id, or null when it had no valid one. */
  readonly operationId: OperationId | null;
  /** The path as the attempt named it, or null when the refusal names none. */
  readonly path: string | null;
  /** Short reason from the refusal. */
  readonly reason: string;
}

/** The input of {@link Journal.appendEvent}: one file event, in the closed vocabulary. */
export type EventAppendInput =
  | { readonly eventKind: "created" | "changed"; readonly path: string; readonly version: string }
  | { readonly eventKind: "deleted"; readonly path: string }
  | { readonly eventKind: "overflow" };

/** How one page of the Journal is selected. */
export interface JournalReadOptions {
  /** Return entries whose `seq` is greater than this decimal string. */
  readonly cursor?: string | undefined;
  /** Page size; defaults to 50. */
  readonly limit?: number | undefined;
}

/** One page of the Journal. */
export interface JournalPage {
  readonly entries: readonly JournalEntry[];
  /** The cursor for the next page; present exactly when more rows exist. */
  readonly next: string | undefined;
}

/** What a watermark write did. */
export interface WatermarkWrite {
  readonly watermark: JournalWatermark;
  /** How many settled entries the checkpoint absorbed. */
  readonly truncated: number;
}

/**
 * The watermark cannot be written: it would move backwards, or it would pass an intent that has
 * no outcome yet.
 *
 * @remarks
 * Both are expected answers, not defects. Moving backwards would replay entries a checkpoint
 * already absorbed; passing an unsettled intent would delete the evidence restore reconciles
 * (INV-04). The caller must not retry the same request blindly.
 */
export class JournalWatermarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalWatermarkError";
  }
}

const SeqSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const SeqRowSchema = v.object({ seq: SeqSchema });
const MetaRowSchema = v.object({ value: v.string() });
const TableSqlRowSchema = v.object({ sql: v.pipe(v.string(), v.minLength(1)) });
const TableColumnRowSchema = v.object({ name: v.pipe(v.string(), v.minLength(1)) });
const CounterSchema = v.pipe(
  v.string(),
  v.regex(/^(0|[1-9][0-9]*)$/u),
  v.transform((text) => Number(text)),
  v.integer(),
  v.minValue(0),
);
const CursorSchema = v.pipe(
  v.string(),
  v.regex(/^(0|[1-9][0-9]*)$/u),
  v.transform((text) => Number(text)),
  v.integer(),
  v.minValue(0),
);
const StoredWatermarkSchema = v.object({
  throughSeq: v.pipe(v.number(), v.integer(), v.minValue(0)),
  at: IsoTimestampSchema,
});

/** The columns every insert sets; a kind leaves the columns it does not use null. */
interface InsertRow {
  readonly seq: number;
  readonly kind: JournalKind;
  readonly operationId: string | null;
  readonly path: string | null;
  readonly at: string;
  readonly expectedVersion: string | null;
  readonly version: string | null;
  readonly currentVersion: string | null;
  readonly status: string | null;
  readonly reason: string | null;
  readonly eventKind: string | null;
  readonly bodyHash: string | null;
  readonly bodyKey: string | null;
  readonly bodySize: number | null;
  readonly body: ArrayBuffer | null;
}

/** One body prepared for its row: the bytes stay inline, or the key names the object. */
interface PreparedBody {
  readonly hash: string;
  readonly size: number;
  readonly bytes: Uint8Array | null;
  readonly key: string | null;
}

/** A body's version, in the one spelling the workspace uses: `sha256:<hex>`. */
async function sha256Version(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return "sha256:" + hex;
}

/** Narrow a parsed entry to an intent, or fail on a query that promised one. */
function intentOf(entry: JournalEntry): JournalIntentEntry {
  if (entry.kind !== "intent") throw new Error("expected a journal intent, got " + entry.kind);
  return entry;
}

/** Narrow a parsed entry to an outcome, or fail on a query that promised one. */
function outcomeOf(entry: JournalEntry): JournalOutcomeEntry {
  if (entry.kind !== "outcome") throw new Error("expected a journal outcome, got " + entry.kind);
  return entry;
}

/** Narrow a parsed entry to an audit, or fail on a query that promised one. */
function auditOf(entry: JournalEntry): JournalAuditEntry {
  if (entry.kind !== "audit") throw new Error("expected a journal audit, got " + entry.kind);
  return entry;
}

/** Narrow a parsed entry to an event, or fail on a query that promised one. */
function eventOf(entry: JournalEntry): JournalEventEntry {
  if (entry.kind !== "event") throw new Error("expected a journal event, got " + entry.kind);
  return entry;
}

/** The hash an existing body was stored under, or null when it recorded none. */
function bodyHashOf(body: JournalBody | null): string | null {
  return body === null ? null : body.hash;
}

/**
 * The Journal inside one Workspace Durable Object.
 *
 * @remarks
 * The Journal is append-only: every entry gets the next `seq` inside a
 * `storage.transaction`, so concurrent appends cannot share a number and no entry is rewritten.
 * One table holds intents, outcomes, audit entries, and events, discriminated by `kind`
 * (`@hns/store/journal`). Bodies up to 256KB stay in the row; a bigger body is written to the
 * object store once, and only its hash, key, and size are committed, so an acknowledged write is
 * never "in R2 but not in the Journal" (docs/durability.md §3.1).
 *
 * Retries are distinguished by `operationId` (INV-04): an intent that already has an outcome
 * returns the recorded outcome, the same intent returns itself, and the same id with different
 * content is denied. An outcome is never rewritten.
 *
 * Truncation is the checkpoint's job (`writeWatermark`): every settled intent and outcome at or
 * below the watermark is in C and is deleted with its body, while audits and events stay for the
 * watcher. The R2 bodies are not deleted here; unreferenced ones are [0168]'s GC.
 *
 * @example
 * ```ts @import.meta.vitest
 * const { DatabaseSync } = await import("node:sqlite");
 * const { Journal } = await import("./journal.ts");
 * const { operationId } = await import("@hns/core");
 * const db = new DatabaseSync(":memory:");
 * const storage = {
 *   sql: {
 *     exec(query: string, ...bindings: (ArrayBuffer | string | number | null)[]) {
 *       const rows = db
 *         .prepare(query)
 *         .all(...bindings.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value)));
 *       return {
 *         toArray() {
 *           return rows;
 *         },
 *       };
 *     },
 *   },
 *   transaction<T>(run: () => Promise<T>) {
 *     return run();
 *   },
 * };
 * const journal = new Journal(storage, { now: () => Date.parse("2026-01-01T00:00:00.000Z") });
 * await journal.ensureSchema();
 * const id = operationId("op-1");
 * const intent = await journal.appendIntent({
 *   operationId: id,
 *   path: "a.txt",
 *   expectedVersion: "absent",
 *   body: new TextEncoder().encode("hello"),
 * });
 * expect(intent.status).toBe("appended");
 * await journal.appendOutcome({
 *   path: "a.txt",
 *   result: { status: "applied", operationId: id, version: "sha256:one" },
 * });
 * const page = await journal.read();
 * expect(page.entries.length).toBe(2);
 * expect(page.next).toBeUndefined();
 * db.close();
 * ```
 */
export class Journal {
  readonly #storage: JournalStorage;
  readonly #clock: () => number;
  readonly #bucket: JournalBucket | undefined;

  /**
   * @param storage - The Durable Object's SQLite storage.
   * @param options - The clock and the object store; production passes both.
   */
  constructor(storage: JournalStorage, options: JournalOptions = {}) {
    this.#storage = storage;
    this.#clock = options.now ?? (() => Date.now());
    this.#bucket = options.bucket;
  }

  /**
   * Create the Journal's tables, rebuilding one that predates the `denied` status.
   *
   * @returns A promise that settles once the tables are ready.
   *
   * @remarks
   * Every statement is idempotent, so the object runs this on each open. It must finish before
   * the object serves a request; the Workspace awaits it inside `blockConcurrencyWhile`.
   */
  async ensureSchema(): Promise<void> {
    await this.#rebuildStatusVocabulary();
    for (const statement of JOURNAL_SCHEMA) this.#exec(statement);
  }

  /**
   * Rebuild the Journal table when its CHECK predates the `denied` outcome status.
   *
   * @remarks
   * SQLite cannot widen a CHECK in place, and the DDL derives the status CHECK from
   * {@link JOURNAL_OUTCOME_STATUSES}. The statements come from `@hns/store`'s
   * `journalUpgradeStatements` and run in one transaction, so a crash cannot strand the rows.
   * The source must have exactly the known previous columns: the copy names them, and a table
   * with extra columns would lose those silently, so that case throws instead.
   */
  async #rebuildStatusVocabulary(): Promise<void> {
    const row = this.#all(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'journal'",
    )[0];
    if (row === undefined) return;
    const sql = v.parse(TableSqlRowSchema, row).sql;
    if (sql.includes("'denied'")) return;
    // The upgrade copies named columns: anything but the known previous schema would lose
    // columns silently, so a surprise fails closed instead.
    const columns = this.#all("SELECT name FROM pragma_table_info('journal')").map(
      (column) => v.parse(TableColumnRowSchema, column).name,
    );
    const expected = [...JOURNAL_COLUMN_NAMES];
    if (
      columns.length !== expected.length ||
      columns.some((name, index) => name !== expected[index])
    ) {
      throw new Error("the journal table is not the known previous schema; refusing to upgrade it");
    }
    await this.#storage.transaction(async () => {
      for (const statement of journalUpgradeStatements()) this.#exec(statement);
    });
  }

  /**
   * Record that a write is about to be attempted.
   *
   * @param input - The attempt's id, path, expected version, and optional body.
   * @returns What the append did; see {@link IntentAppend}. A retry returns the recorded entry
   * instead of appending, and different content under the same id is `denied`.
   * @throws Error when a body over 256KB has no object store, when the store refuses the write,
   * or when the same id is already pending elsewhere with different content.
   *
   * @remarks
   * A body over 256KB is put to the object store before the row is committed, so a failed put
   * leaves no intent behind. The whole check-and-append runs in one transaction: two concurrent
   * attempts with the same id cannot both append.
   */
  async appendIntent(input: IntentAppendInput): Promise<IntentAppend> {
    const body = input.body === undefined ? null : await this.#prepareBody(input.body);
    const outcome: IntentAppend = await this.#storage.transaction(async () => {
      const settled = this.#outcomeRow(input.operationId);
      if (settled !== undefined) {
        // A settled operation is only replayed for the same attempt: the intent still
        // records what was sent, so another body under the same id is refused (INV-04).
        const prior = this.#intentRow(input.operationId);
        if (prior !== undefined) {
          const intent = intentOf(parseJournalEntry(prior));
          const same =
            intent.path === input.path &&
            intent.expectedVersion === input.expectedVersion &&
            bodyHashOf(intent.body) === (body === null ? null : body.hash);
          if (!same) return { status: "denied", reason: "operation_id_reused" };
        }
        return { status: "settled", entry: outcomeOf(parseJournalEntry(settled)) };
      }
      const pending = this.#intentRow(input.operationId);
      if (pending !== undefined) {
        const entry = intentOf(parseJournalEntry(pending));
        const same =
          entry.path === input.path &&
          entry.expectedVersion === input.expectedVersion &&
          bodyHashOf(entry.body) === (body === null ? null : body.hash);
        return same
          ? { status: "pending", entry }
          : { status: "denied", reason: "operation_id_reused" };
      }
      const seq = this.#nextSeq();
      this.#insert({
        seq,
        kind: "intent",
        operationId: input.operationId,
        path: input.path,
        at: this.#stamp(),
        expectedVersion: input.expectedVersion,
        version: null,
        currentVersion: null,
        status: null,
        reason: null,
        eventKind: null,
        bodyHash: body === null ? null : body.hash,
        bodyKey: body === null ? null : body.key,
        bodySize: body === null ? null : body.size,
        body: body === null || body.bytes === null ? null : new Uint8Array(body.bytes).buffer,
      });
      return { status: "appended", entry: intentOf(this.#entryAt(seq)) };
    });
    return outcome;
  }

  /**
   * Record what happened to an intent.
   *
   * @param input - The path and the result to record.
   * @returns `appended` for the first outcome, or `settled` with the recorded one on a retry.
   * @throws Error when no intent names the result's `operationId`, or when the path differs.
   *
   * @remarks
   * An outcome is written once. A second settle of the same id returns the first outcome even
   * when the new result disagrees, because the first answer is the one the caller was given.
   */
  async appendOutcome(input: OutcomeAppendInput): Promise<OutcomeAppend> {
    return await this.settle(input);
  }

  /**
   * Record an outcome and, in the same transaction, whatever the outcome implies.
   *
   * @param input - The path and the result to record.
   * @param after - Optional work inside the outcome's transaction; it runs only when this call
   * appended the outcome, never for a retry that finds it settled.
   * @returns `appended` for the first outcome, or `settled` with the recorded one on a retry.
   * @throws Error when no intent names the result's `operationId`, or when the path differs.
   *
   * @remarks
   * The outcome is the ack (INV-10), so everything the ack implies (the version table, the file
   * event, the project binding) must commit with it: a crash cannot leave a version or an event
   * without the outcome, and a retry that finds the outcome settled does not repeat the work.
   * The callback receives the stored entry; it runs inside the transaction, so it may only
   * touch the same storage.
   */
  async settle(
    input: OutcomeAppendInput,
    after?: (entry: JournalOutcomeEntry) => void,
  ): Promise<OutcomeAppend> {
    const operationId = v.parse(OperationIdSchema, input.result.operationId);
    const outcome: OutcomeAppend = await this.#storage.transaction(async () => {
      const settled = this.#outcomeRow(operationId);
      if (settled !== undefined) {
        return { status: "settled", entry: outcomeOf(parseJournalEntry(settled)) };
      }
      const intentRow = this.#intentRow(operationId);
      if (intentRow === undefined) {
        throw new Error("cannot settle an operation with no intent: " + String(operationId));
      }
      const intent = intentOf(parseJournalEntry(intentRow));
      if (intent.path !== input.path) {
        throw new Error("the outcome path differs from its intent: " + String(operationId));
      }
      const seq = this.#nextSeq();
      const result = input.result;
      this.#insert({
        seq,
        kind: "outcome",
        operationId,
        path: input.path,
        at: this.#stamp(),
        expectedVersion: null,
        version: result.status === "applied" ? result.version : null,
        currentVersion: result.status === "conflict" ? result.currentVersion : null,
        status: result.status,
        reason: result.status === "unknown" || result.status === "denied" ? result.reason : null,
        eventKind: null,
        bodyHash: null,
        bodyKey: null,
        bodySize: null,
        body: null,
      });
      const entry = outcomeOf(this.#entryAt(seq));
      if (after !== undefined) after(entry);
      return { status: "appended", entry };
    });
    return outcome;
  }

  /**
   * Append one file event inside the caller's transaction.
   *
   * @param input - The event kind and, for a file event, its path and version.
   * @returns The stored entry.
   *
   * @remarks
   * The workspace calls this from {@link settle}'s callback so an applied outcome, its version,
   * and its event are one transaction. Calling it outside a transaction would need its own, so
   * the public {@link appendEvent} wraps it.
   */
  appendEventInTransaction(input: EventAppendInput): JournalEventEntry {
    const seq = this.#nextSeq();
    const path = input.eventKind === "overflow" ? null : input.path;
    const version =
      input.eventKind === "created" || input.eventKind === "changed" ? input.version : null;
    this.#insert({
      seq,
      kind: "event",
      operationId: null,
      path,
      at: this.#stamp(),
      expectedVersion: null,
      version,
      currentVersion: null,
      status: null,
      reason: null,
      eventKind: input.eventKind,
      bodyHash: null,
      bodyKey: null,
      bodySize: null,
      body: null,
    });
    return eventOf(this.#entryAt(seq));
  }

  /**
   * Append one refusal to the audit trail.
   *
   * @param input - The id (when valid), the path, and a short reason.
   * @returns The stored entry.
   *
   * @remarks
   * Audits are never deduplicated or truncated: a retried refusal is evidence of another
   * attempt, and no checkpoint can absorb a write that never happened.
   */
  async appendAudit(input: AuditAppendInput): Promise<JournalAuditEntry> {
    const entry: JournalAuditEntry = await this.#storage.transaction(async () => {
      const seq = this.#nextSeq();
      this.#insert({
        seq,
        kind: "audit",
        operationId: input.operationId,
        path: input.path,
        at: this.#stamp(),
        expectedVersion: null,
        version: null,
        currentVersion: null,
        status: null,
        reason: input.reason,
        eventKind: null,
        bodyHash: null,
        bodyKey: null,
        bodySize: null,
        body: null,
      });
      return auditOf(this.#entryAt(seq));
    });
    return entry;
  }

  /**
   * Append one file event.
   *
   * @param input - The event kind and, for a file event, its path and version.
   * @returns The stored entry.
   *
   * @remarks
   * Events are kept by truncation so `watch(cursor)` replays the stream instead of re-reading
   * every file.
   */
  async appendEvent(input: EventAppendInput): Promise<JournalEventEntry> {
    return await this.#storage.transaction(async () => this.appendEventInTransaction(input));
  }

  /**
   * The outcome recorded for an operation, or undefined while it is pending.
   *
   * @param operationId - The attempt's id.
   * @returns The stored outcome; a lookup by the unique index, never a scan.
   */
  outcomeFor(operationId: OperationId): JournalOutcomeEntry | undefined {
    const row = this.#outcomeRow(operationId);
    return row === undefined ? undefined : outcomeOf(parseJournalEntry(row));
  }

  /**
   * Read one bounded page, oldest first.
   *
   * @param options - The cursor (last seen seq) and the page size.
   * @returns The entries in `seq` order and the next cursor when more rows exist. Bodies over
   * 256KB are fetched from the object store, so the entries carry their bytes.
   * @throws RangeError when `limit` is outside 1..{@link JOURNAL_READ_MAX_LIMIT}.
   * @throws ValiError when the cursor is not a decimal seq.
   * @throws Error when an object body is missing from a bound object store.
   *
   * @remarks
   * The cursor is keyset, not offset: truncation between pages can remove rows but cannot make
   * the reader skip or repeat one. A full read is not offered.
   */
  async read(options: JournalReadOptions = {}): Promise<JournalPage> {
    const limit = options.limit ?? JOURNAL_READ_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > JOURNAL_READ_MAX_LIMIT) {
      throw new RangeError(
        "the journal page size must be 1.." +
          String(JOURNAL_READ_MAX_LIMIT) +
          ", got " +
          String(limit),
      );
    }
    const after = options.cursor === undefined ? 0 : v.parse(CursorSchema, options.cursor);
    const rows = this.#all(
      "SELECT * FROM journal WHERE seq > ? ORDER BY seq ASC LIMIT ?",
      after,
      limit + 1,
    );
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const entries: JournalEntry[] = [];
    for (const row of page) entries.push(await this.#resolveBody(parseJournalEntry(row)));
    const last = entries[entries.length - 1];
    return { entries, next: more && last !== undefined ? String(last.seq) : undefined };
  }

  /**
   * Write the checkpoint watermark and truncate what it absorbed.
   *
   * @param throughSeq - Every entry at or below this sequence is in the checkpoint.
   * @returns The watermark and how many settled entries were deleted.
   * @throws RangeError when `throughSeq` is not a non-negative integer.
   * @throws {@link JournalWatermarkError} when the watermark would move backwards or pass an
   * intent that has no outcome.
   *
   * @remarks
   * One transaction writes the watermark and deletes the intents and outcomes at or below it, so
   * a crash cannot leave a watermark without its truncation (the truncation is idempotent, so a
   * retry is safe). Audit entries and events stay, and the R2 bodies the deleted intents
   * referenced are left for the retention GC.
   */
  async writeWatermark(throughSeq: number): Promise<WatermarkWrite> {
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) {
      throw new RangeError("the journal watermark must be a non-negative integer");
    }
    const written: WatermarkWrite = await this.#storage.transaction(async () => {
      const current = this.#watermark();
      if (current !== undefined && throughSeq < current.throughSeq) {
        throw new JournalWatermarkError(
          "the journal watermark never decreases: " + String(current.throughSeq),
        );
      }
      const pending = this.#firstPendingIntent(throughSeq);
      if (pending !== undefined) {
        throw new JournalWatermarkError(
          "the watermark would pass an unsettled intent at seq " + String(pending),
        );
      }
      const watermark: JournalWatermark = {
        throughSeq,
        at: isoTimestamp(new Date(this.#clock()).toISOString()),
      };
      this.#setMeta("watermark", JSON.stringify(watermark));
      const settled = this.#all(
        "SELECT seq FROM journal WHERE seq <= ? AND kind IN ('intent', 'outcome')",
        throughSeq,
      );
      this.#exec(
        "DELETE FROM journal WHERE seq <= ? AND kind IN ('intent', 'outcome')",
        throughSeq,
      );
      return { watermark, truncated: settled.length };
    });
    return written;
  }

  /**
   * The current checkpoint watermark, or undefined before the first checkpoint.
   */
  watermark(): JournalWatermark | undefined {
    return this.#watermark();
  }

  /** Read the watermark from the meta row, if a checkpoint wrote one. */
  #watermark(): JournalWatermark | undefined {
    const value = this.#meta("watermark");
    if (value === undefined) return undefined;
    const parsed: unknown = JSON.parse(value);
    return v.parse(StoredWatermarkSchema, parsed);
  }

  /** The first intent at or below `throughSeq` that has no outcome yet. */
  #firstPendingIntent(throughSeq: number): number | undefined {
    const row = this.#all(
      "SELECT intent.seq AS seq FROM journal AS intent WHERE intent.kind = 'intent' AND intent.seq <= ? AND NOT EXISTS (SELECT 1 FROM journal AS outcome WHERE outcome.kind = 'outcome' AND outcome.operation_id = intent.operation_id AND outcome.seq > intent.seq) ORDER BY intent.seq ASC LIMIT 1",
      throughSeq,
    )[0];
    return row === undefined ? undefined : v.parse(SeqRowSchema, row).seq;
  }

  /** Hash a body, and put it to the object store when it does not fit in a row. */
  async #prepareBody(bytes: Uint8Array): Promise<PreparedBody> {
    const hash = await sha256Version(bytes);
    const size = bytes.byteLength;
    if (size <= JOURNAL_INLINE_BODY_MAX_BYTES) {
      return { hash, size, bytes, key: null };
    }
    if (this.#bucket === undefined) {
      throw new Error(
        "a journal body over " +
          String(JOURNAL_INLINE_BODY_MAX_BYTES) +
          " bytes needs the object store",
      );
    }
    const key = journalBodyKey(hash);
    if ((await this.#bucket.head(key)) === null) {
      const stored = await this.#bucket.put(key, bytes);
      if (stored === null) throw new Error("the object store refused " + key);
    }
    return { hash, size, bytes: null, key };
  }

  /** Attach the bytes of an object body, so a reader never has to call R2 itself. */
  async #resolveBody(entry: JournalEntry): Promise<JournalEntry> {
    if (entry.kind !== "intent" || entry.body === null || entry.body.storage === "inline") {
      return entry;
    }
    const body = entry.body;
    if (this.#bucket === undefined) {
      throw new Error("the journal body " + body.key + " needs the object store");
    }
    const stored = await this.#bucket.get(body.key);
    if (stored === null) {
      throw new Error("the journal body is missing from the object store: " + body.key);
    }
    const bytes = new Uint8Array(await stored.arrayBuffer());
    if (bytes.byteLength !== body.size) {
      throw new Error("the journal body " + body.key + " does not match its recorded size");
    }
    return { ...entry, body: { ...body, bytes } };
  }

  /** One parsed row by seq, for the entry an append just wrote. */
  #entryAt(seq: number): JournalEntry {
    const row = this.#all("SELECT * FROM journal WHERE seq = ?", seq)[0];
    if (row === undefined) {
      throw new Error("the journal lost the row it appended at seq " + String(seq));
    }
    return parseJournalEntry(row);
  }

  #intentRow(operationId: OperationId): Row | undefined {
    return this.#all(
      "SELECT * FROM journal WHERE kind = 'intent' AND operation_id = ?",
      operationId,
    )[0];
  }

  #outcomeRow(operationId: OperationId): Row | undefined {
    return this.#all(
      "SELECT * FROM journal WHERE kind = 'outcome' AND operation_id = ?",
      operationId,
    )[0];
  }

  /** The next sequence number, inside the caller's transaction. */
  #nextSeq(): number {
    const current = this.#meta("seq");
    const next = (current === undefined ? 0 : v.parse(CounterSchema, current)) + 1;
    this.#setMeta("seq", String(next));
    return next;
  }

  /** Now, in the one timestamp spelling the Journal stores. */
  #stamp(): string {
    return isoTimestamp(new Date(this.#clock()).toISOString());
  }

  #meta(key: string): string | undefined {
    const row = this.#all("SELECT value FROM journal_meta WHERE key = ?", key)[0];
    return row === undefined ? undefined : v.parse(MetaRowSchema, row).value;
  }

  #setMeta(key: string, value: string): void {
    this.#exec(
      "INSERT INTO journal_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  #insert(row: InsertRow): void {
    this.#exec(
      "INSERT INTO journal (seq, kind, operation_id, path, at, expected_version, version, current_version, status, reason, event_kind, body_hash, body_key, body_size, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.seq,
      row.kind,
      row.operationId,
      row.path,
      row.at,
      row.expectedVersion,
      row.version,
      row.currentVersion,
      row.status,
      row.reason,
      row.eventKind,
      row.bodyHash,
      row.bodyKey,
      row.bodySize,
      row.body,
    );
  }

  #exec(query: string, ...bindings: SqlValue[]): void {
    this.#storage.sql.exec(query, ...bindings);
  }

  #all(query: string, ...bindings: SqlValue[]): Row[] {
    return this.#storage.sql.exec(query, ...bindings).toArray();
  }
}
