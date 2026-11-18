import {
  OFFICE_ERROR_CODES,
  OFFICE_FORMATS,
  OFFICE_OPERATIONS,
  OFFICE_PATH_HASH_PATTERN,
  OFFICE_PARAMS_HASH_PATTERN,
  OFFICE_SHA256_PATTERN,
  PREVIEW_STATUSES,
} from "@hns/core/office";
import type {
  OfficeErrorCode,
  OfficeFormat,
  OfficeOperation,
  PreviewStatus,
} from "@hns/core/office";
import * as v from "valibot";

/**
 * The longest an unfinished preview row waits between two alarm passes (0237 U-02).
 *
 * @remarks
 * The alarm is armed at \`min(wake, this)\`, so a \`queued\`, \`generating\`, or \`stale\` row is asked
 * about again even when the Session is idle. Two minutes is the design's number for one attempt
 * plus its retries (U-02): longer than an attempt's own budget (60 s) and the retry pause (30 s),
 * so a row never outlives an alarm that would have settled it.
 */
export const OFFICE_ROW_TTL_MS = 120_000;

/**
 * How many times the alarm asks the machine before a row is answered \`failed\`.
 *
 * @remarks
 * The first attempt plus two retries: a machine that was down for a moment is retried, and one
 * that stays down is answered \`engine_unavailable\` after about a minute, which is inside
 * {@link OFFICE_ROW_TTL_MS}.
 */
export const OFFICE_MAX_ATTEMPTS = 3;

/** The pause between two attempts when the machine gave no answer at all (a \`stale\` row). */
export const OFFICE_RETRY_MS = 30_000;

/**
 * One preview row (0237, "Design: reference-level").
 *
 * @remarks
 * The row is the state the GraphQL face answers from and the alarm reads. \`(workspaceId, path,
 * version)\` is what makes it one job: the request reuses a row with the same three, and deletes
 * every other version of the same path (C2, C4). \`paramsHash\` is carried so the route reads the
 * value the job hashed rather than recomputing the defaults in a second place.
 *
 * **\`workspaceId\` is in the key because the machine is one workspace.** The server checks it
 * against the Session before it hands a path to the machine, and a row that named another
 * workspace is not a row this object may serve.
 */
export interface OfficePreviewRow {
  /** The workspace the row belongs to: the Session's name. */
  readonly workspaceId: string;
  /** The workspace-relative path the row previews. */
  readonly path: string;
  /** The version of the file the job read: \`sha256:<hex>\`. */
  readonly version: string;
  /** The format the path's extension named. */
  readonly format: OfficeFormat;
  /** The job: always \`preview\` in this build. */
  readonly operation: OfficeOperation;
  /** Where the row is in the seven states. */
  readonly status: PreviewStatus;
  /** The expected failure that produced \`failed\`; absent otherwise. */
  readonly code: OfficeErrorCode | null;
  /** The engine's message for \`failed\`; absent otherwise. */
  readonly message: string | null;
  /** Pages in the preview, once \`ready\`. */
  readonly pages: number | null;
  /** Bytes in the preview, once \`ready\`. */
  readonly bytes: number | null;
  /** The engine's version, once \`ready\`. */
  readonly engine: string | null;
  /** When the row last changed, epoch milliseconds. */
  readonly updatedAt: number;
  /**
   * When the row was created, epoch milliseconds (0237, C9).
   *
   * @remarks
   * The row's **deadline** is this plus {@link OFFICE_ROW_TTL_MS}, and a retry does not move it:
   * the TTL is the bound on how long one preview may keep the alarm, not a pause between two
   * attempts. A row past it is answered `failed(engine_timeout)` by the next pass instead of
   * being retried forever (the object's alarm costs a request each time it is set).
   */
  readonly createdAt: number;
  /** The artifact key's params hash: what the route reads a preview by. */
  readonly paramsHash: string;
  /** The artifact key's path hash. */
  readonly pathHash: string;
  /** How many times the alarm asked the machine. */
  readonly attempts: number;
  /** The job id the machine's answer names, once one arrived. */
  readonly jobId: string | null;
}

/** The state one row is written with. */
export interface OfficeRowWrite {
  readonly status: PreviewStatus;
  readonly code?: OfficeErrorCode | null | undefined;
  readonly message?: string | null | undefined;
  readonly pages?: number | null | undefined;
  readonly bytes?: number | null | undefined;
  readonly engine?: string | null | undefined;
  readonly attempts?: number | undefined;
  readonly jobId?: string | null | undefined;
  readonly now: number;
  /** When the row was created; defaults to `now` for a row this write creates. */
  readonly createdAt?: number | undefined;
}

/** The identity of one row, which only the request that creates it writes. */
export interface OfficeRowKey {
  readonly workspaceId: string;
  readonly path: string;
  readonly version: string;
  readonly format: OfficeFormat;
  readonly operation: OfficeOperation;
  readonly pathHash: string;
  readonly paramsHash: string;
}

/**
 * The preview rows the Session object keeps in its own SQLite (0237).
 *
 * @remarks
 * One table, keyed by \`(workspace_id, path, version)\`, so the two requests that must be one row
 * collide in the database rather than in the caller's bookkeeping. "Delete the path's old
 * versions and write this one" is a single transaction, so a crash cannot leave the object with
 * neither.
 */
export interface OfficeRows {
  /** Every row with this workspace and path, oldest first. */
  rowsFor(workspaceId: string, path: string): Promise<readonly OfficePreviewRow[]>;
  /** The workspace's rows that are not finished, so the alarm can be armed for them. */
  unsettled(workspaceId: string): Promise<readonly OfficePreviewRow[]>;
  /** The row for this key, or undefined. */
  get(workspaceId: string, path: string, version: string): Promise<OfficePreviewRow | undefined>;
  /**
   * Delete every row for this path that is not this version, then write this version's row.
   *
   * @param key - The row's identity.
   * @param write - The state to write.
   * @param decision - What {@link officeRowDecision} decided for the existing row.
   * @returns Nothing; the old versions are gone and the row is written.
   *
   * @remarks
   * The delete and the write are one transaction (C4): a request for a new version leaves the
   * old rows gone and the new one present, never both or neither. The write is an
   * `INSERT OR REPLACE` on `(workspaceId, path, version)`, so two requests for the same key land
   * on one row however they interleave (C2); `decision` says which state that row takes.
   */
  write(key: OfficeRowKey, write: OfficeRowWrite): Promise<void>;
  /** Update one row's state. A row that is gone is not created by this. */
  update(workspaceId: string, path: string, version: string, write: OfficeRowWrite): Promise<void>;
}

/** One value the object's SQLite returns: the binding's own closed set. */
export type OfficeSqlValue = ArrayBuffer | string | number | null;

/** The row a statement returns: the binding's values, keyed by column, parsed by the caller. */
export type OfficeSqlRow = Readonly<Record<string, OfficeSqlValue>>;

/** The storage one store is written over. */
export interface OfficeRowStorage {
  readonly sql: {
    exec(query: string, ...bindings: readonly OfficeSqlValue[]): { toArray(): OfficeSqlRow[] };
  };
  transaction<T>(run: () => Promise<T>): Promise<T>;
}

/** One stored row, parsed at the boundary. */
const RowSchema = v.object({
  workspaceId: v.string(),
  path: v.string(),
  version: v.pipe(v.string(), v.regex(OFFICE_SHA256_PATTERN, "a version is sha256:<64 hex>")),
  format: v.picklist(OFFICE_FORMATS),
  operation: v.picklist(OFFICE_OPERATIONS),
  status: v.picklist(PREVIEW_STATUSES),
  code: v.nullable(v.picklist(OFFICE_ERROR_CODES)),
  message: v.nullable(v.string()),
  pages: v.nullable(v.number()),
  bytes: v.nullable(v.number()),
  engine: v.nullable(v.string()),
  updatedAt: v.number(),
  createdAt: v.number(),
  paramsHash: v.pipe(v.string(), v.regex(OFFICE_PARAMS_HASH_PATTERN, "a params hash is 16 hex")),
  pathHash: v.pipe(v.string(), v.regex(OFFICE_PATH_HASH_PATTERN, "a path hash is 16 hex")),
  attempts: v.number(),
  jobId: v.nullable(v.string()),
});

/** One nullable text column: a string or null, and no other SQL value. */
const TextColumn = v.nullable(v.string());

/** One nullable integer column: a number or null, and no other SQL value. */
const NumberColumn = v.nullable(v.number());

/**
 * Read one column of a row as text.
 *
 * @param raw - The row the object's SQLite returned.
 * @param column - The column's name.
 * @returns The text, or null for a SQL null.
 * @throws {v.ValiError} When the column holds anything but text or null.
 */
function textOf(raw: OfficeSqlRow, column: string): string | null {
  return v.parse(TextColumn, raw[column] ?? null);
}

/**
 * Read one column of a row as a number.
 *
 * @param raw - The row the object's SQLite returned.
 * @param column - The column's name.
 * @returns The number, or null for a SQL null.
 * @throws {v.ValiError} When the column holds anything but a number or null.
 */
function numberOf(raw: OfficeSqlRow, column: string): number | null {
  return v.parse(NumberColumn, raw[column] ?? null);
}

/**
 * Read one returned row, or fail loudly.
 *
 * @param raw - The row the object's SQLite returned.
 * @returns The row, parsed at the boundary.
 * @throws {v.ValiError} When the stored row is not a row this build can read.
 *
 * @remarks
 * A row that does not parse is a defect, not an expected failure: it means the table and the
 * type disagree, and answering it as a \`failed\` preview would hide that.
 */
function rowOf(raw: OfficeSqlRow): OfficePreviewRow {
  return v.parse(RowSchema, {
    workspaceId: textOf(raw, "workspace_id"),
    path: textOf(raw, "path"),
    version: textOf(raw, "version"),
    format: textOf(raw, "format"),
    operation: textOf(raw, "operation"),
    status: textOf(raw, "status"),
    code: textOf(raw, "code"),
    message: textOf(raw, "message"),
    pages: numberOf(raw, "pages"),
    bytes: numberOf(raw, "bytes"),
    engine: textOf(raw, "engine"),
    updatedAt: numberOf(raw, "updated_at"),
    createdAt: numberOf(raw, "created_at"),
    paramsHash: textOf(raw, "params_hash"),
    pathHash: textOf(raw, "path_hash"),
    attempts: numberOf(raw, "attempts"),
    jobId: textOf(raw, "job_id"),
  });
}

const SELECT = "SELECT * FROM office_preview";

/**
 * Create the preview row store over one Session's SQLite.
 *
 * @param storage - The object's storage.
 * @returns The rows.
 *
 * @remarks
 * The table is created here rather than by a migration: it is the object's own state, it is
 * derived, and a lost table costs one regeneration rather than a lost record.
 */
export function createOfficeRows(storage: OfficeRowStorage): OfficeRows {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS office_preview (" +
      "workspace_id TEXT NOT NULL, path TEXT NOT NULL, version TEXT NOT NULL, " +
      "format TEXT NOT NULL, operation TEXT NOT NULL, status TEXT NOT NULL, " +
      "code TEXT, message TEXT, pages INTEGER, bytes INTEGER, engine TEXT, " +
      "updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL, " +
      "params_hash TEXT NOT NULL, path_hash TEXT NOT NULL, " +
      "attempts INTEGER NOT NULL, job_id TEXT, " +
      "PRIMARY KEY (workspace_id, path, version))",
  );

  const INSERT =
    "INSERT OR REPLACE INTO office_preview (workspace_id, path, version, format, operation, " +
    "status, code, message, pages, bytes, engine, updated_at, created_at, params_hash, " +
    "path_hash, attempts, job_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

  return {
    async rowsFor(workspaceId, path) {
      return storage.sql
        .exec(
          SELECT + " WHERE workspace_id = ? AND path = ? ORDER BY updated_at",
          workspaceId,
          path,
        )
        .toArray()
        .map(rowOf);
    },
    async unsettled(workspaceId) {
      return storage.sql
        .exec(
          SELECT +
            " WHERE workspace_id = ? AND status IN ('queued', 'generating', 'stale') " +
            "ORDER BY updated_at",
          workspaceId,
        )
        .toArray()
        .map(rowOf);
    },
    async get(workspaceId, path, version) {
      const found = storage.sql
        .exec(
          SELECT + " WHERE workspace_id = ? AND path = ? AND version = ?",
          workspaceId,
          path,
          version,
        )
        .toArray();
      const raw = found[0];
      return raw === undefined ? undefined : rowOf(raw);
    },
    async write(key, write) {
      await storage.transaction(async () => {
        // C4: the versions this path had before are gone the moment a new one is asked for.
        storage.sql.exec(
          "DELETE FROM office_preview WHERE workspace_id = ? AND path = ? AND version <> ?",
          key.workspaceId,
          key.path,
          key.version,
        );
        // A reused row is written from its own state, not from a new one: the row is the same
        // row, the key is the same key, and the caller passes the state it decided to keep.
        storage.sql.exec(
          INSERT,
          key.workspaceId,
          key.path,
          key.version,
          key.format,
          key.operation,
          write.status,
          write.code ?? null,
          write.message ?? null,
          write.pages ?? null,
          write.bytes ?? null,
          write.engine ?? null,
          write.now,
          // The deadline is fixed when the row is created: a rewrite keeps the moment it was
          // created, so a retry cannot extend it (0237, C9).
          write.createdAt ?? write.now,
          key.paramsHash,
          key.pathHash,
          write.attempts ?? 0,
          write.jobId ?? null,
        );
      });
    },
    async update(workspaceId, path, version, write) {
      storage.sql.exec(
        "UPDATE office_preview SET status = ?, code = ?, message = ?, pages = ?, bytes = ?, " +
          "engine = ?, updated_at = ?, attempts = ?, job_id = ? " +
          "WHERE workspace_id = ? AND path = ? AND version = ?",
        write.status,
        write.code ?? null,
        write.message ?? null,
        write.pages ?? null,
        write.bytes ?? null,
        write.engine ?? null,
        write.now,
        write.attempts ?? 0,
        write.jobId ?? null,
        workspaceId,
        path,
        version,
      );
    },
  };
}
