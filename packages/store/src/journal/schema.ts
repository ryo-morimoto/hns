/**
 * The Journal's storage shape: one append-only table, discriminated by `kind`.
 *
 * @remarks
 * The Journal is authoritative state (`J` in `(C, J)`, docs/durability.md §1). One table holds
 * intents, outcomes, audit entries, and events so one mutation never fans out into several row
 * types; `kind` says which shape a row has and `seq` orders every append. The table lives in the
 * Workspace Durable Object's SQLite, so the DO creates it on open.
 *
 * The one implementation is the DO's (`packages/server/src/do/journal.ts`): the transaction per
 * mutation, the body spilling to R2, the watermark and truncation, and paged reads. This package
 * owns the boundary it shares with that implementation — the DDL and its upgrade, the row shape,
 * the parser, the object-store key, and the closed vocabularies a row may hold — so a reader
 * outside the DO (a restore, a test) validates the same shapes the DO writes. This package has no
 * second journal implementation and no dependency on the DO.
 */
import { MUTATION_UNKNOWN_REASONS } from "@hns/core";

/** The closed set of entries the Journal stores. */
export const JOURNAL_KINDS = ["intent", "outcome", "audit", "event"] as const;

/** One entry shape in the Journal table. */
export type JournalKind = (typeof JOURNAL_KINDS)[number];

/**
 * The closed event vocabulary, the same names `docs/workspace.md` gives a file event.
 *
 * @remarks
 * `overflow` carries no path: it means coverage was lost, so a watcher must re-read what it
 * trusts instead of following the stream as a diff.
 */
export const JOURNAL_EVENT_KINDS = ["created", "changed", "deleted", "overflow"] as const;

/** One kind of file event a Journal row can carry. */
export type JournalEventKind = (typeof JOURNAL_EVENT_KINDS)[number];

/**
 * The outcome statuses.
 *
 * @remarks
 * `applied`, `conflict`, and `unknown` come from `MutationResult`; `denied` is the
 * Journal's own answer for a write the machine refused before it wrote anything. A denied
 * outcome settles its intent, so the checkpoint watermark can pass it and the retry returns
 * the same refusal. The application contract (`MutationResult`) does not gain the member.
 */
export const JOURNAL_OUTCOME_STATUSES = ["applied", "conflict", "unknown", "denied"] as const;

/** One stored outcome status. */
export type JournalOutcomeStatus = (typeof JOURNAL_OUTCOME_STATUSES)[number];

/** Why an outcome is unknown, the machine's list from the core model. */
export const JOURNAL_UNKNOWN_REASONS = MUTATION_UNKNOWN_REASONS;

/**
 * The largest body that stays in its row: 256KB.
 *
 * @remarks
 * A bigger body goes to the object store and only its hash, key, and size stay in the row. The
 * reason is the DO's 128MB memory limit and restore time, not the price
 * (docs/durability.md §3.1).
 */
export const JOURNAL_INLINE_BODY_MAX_BYTES = 256 * 1024;

/**
 * The most rows one mutation appends: an intent, an outcome, and up to three events.
 *
 * @remarks
 * The bound keeps row billing predictable (docs/durability.md §7). A commit per token, or a
 * row per mutation field, would multiply it by two orders of magnitude.
 */
export const JOURNAL_MAX_ROWS_PER_MUTATION = 5;

/** The object-store prefix for Journal bodies; git objects use `objects/`. */
export const JOURNAL_BODY_PREFIX = "journal/";

/** The shape of a body hash: `sha256:<64 lowercase hex>`. */
export const JOURNAL_BODY_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;

/**
 * The object-store key of one body.
 *
 * @param hash - The body hash, `sha256:<hex>`.
 * @returns `journal/<hex>`; the same bytes always land on the same key.
 * @throws Error when `hash` is not a `sha256:<hex>` hash.
 */
export function journalBodyKey(hash: string): string {
  if (!JOURNAL_BODY_HASH_PATTERN.test(hash)) {
    throw new Error("a journal body key needs a sha256:<hex> hash");
  }
  return JOURNAL_BODY_PREFIX + hash.slice("sha256:".length);
}

/** Quote a closed vocabulary for the DDL, so the table and the types cannot drift. */
const sqlList = (values: readonly string[]): string =>
  values.map((value) => "'" + value + "'").join(", ");

/**
 * The statements that create the Journal.
 *
 * @remarks
 * Every statement is idempotent, so the Workspace DO runs the list on open. The CHECK
 * constraints are built from the same arrays the parser uses, so a new kind cannot be stored
 * without being readable. A body is only allowed on an intent, because the intent is the write's
 * content (docs/durability.md §3.1); an outcome records what happened to it.
 */
export const JOURNAL_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS journal (
  seq INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  operation_id TEXT,
  path TEXT,
  at TEXT NOT NULL,
  expected_version TEXT,
  version TEXT,
  current_version TEXT,
  status TEXT,
  reason TEXT,
  event_kind TEXT,
  body_hash TEXT,
  body_key TEXT,
  body_size INTEGER,
  body BLOB,
  CHECK (kind IN (${sqlList(JOURNAL_KINDS)})),
  CHECK ((kind = 'intent' AND expected_version IS NOT NULL) OR (kind <> 'intent' AND expected_version IS NULL)),
  CHECK ((kind = 'outcome' AND status IN (${sqlList(JOURNAL_OUTCOME_STATUSES)})) OR (kind <> 'outcome' AND status IS NULL)),
  CHECK ((kind = 'event' AND event_kind IN (${sqlList(JOURNAL_EVENT_KINDS)})) OR (kind <> 'event' AND event_kind IS NULL)),
  CHECK (body IS NULL OR (kind = 'intent' AND body_key IS NULL)),
  CHECK (body_key IS NULL OR (kind = 'intent' AND body IS NULL AND body_hash IS NOT NULL AND body_size IS NOT NULL)),
  CHECK ((body_hash IS NULL) = (body_size IS NULL)),
  CHECK (body IS NULL OR (body_hash IS NOT NULL AND body_size = length(body)))
)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS journal_intent_operation ON journal (operation_id) WHERE kind = 'intent'",
  "CREATE UNIQUE INDEX IF NOT EXISTS journal_outcome_operation ON journal (operation_id) WHERE kind = 'outcome'",
  "CREATE INDEX IF NOT EXISTS journal_kind_seq ON journal (kind, seq)",
  "CREATE TABLE IF NOT EXISTS journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
];
/**
 * The columns of the Journal table, in DDL order.
 *
 * @remarks
 * The upgrade copies these explicitly rather than with `SELECT *`, so a column added later
 * cannot silently shift into another slot.
 */
export const JOURNAL_COLUMN_NAMES = [
  "seq",
  "kind",
  "operation_id",
  "path",
  "at",
  "expected_version",
  "version",
  "current_version",
  "status",
  "reason",
  "event_kind",
  "body_hash",
  "body_key",
  "body_size",
  "body",
] as const;

const JOURNAL_COLUMNS = JOURNAL_COLUMN_NAMES.join(", ");

/**
 * The statements that widen an existing Journal table to the current schema.
 *
 * @returns The statements, in order, to run inside one transaction.
 *
 * @remarks
 * SQLite cannot widen a CHECK constraint, so a table created before `denied` joined the
 * outcome statuses is renamed, recreated, copied, and replaced. The indexes are recreated after
 * the old table (and its indexes) is dropped, because their names are taken until then. A crash
 * cannot strand rows: the whole list runs in one transaction, so either the old table is still
 * the Journal or the new one has every row.
 */
export function journalUpgradeStatements(): readonly string[] {
  return [
    "ALTER TABLE journal RENAME TO journal_previous",
    ...JOURNAL_SCHEMA,
    "INSERT INTO journal (" +
      JOURNAL_COLUMNS +
      ") SELECT " +
      JOURNAL_COLUMNS +
      " FROM journal_previous",
    "DROP TABLE journal_previous",
    ...JOURNAL_SCHEMA,
  ];
}
