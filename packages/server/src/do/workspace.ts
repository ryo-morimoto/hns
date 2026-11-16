import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {
  OperationIdSchema,
  isoTimestamp,
  type LeaseRefusal,
  type MutationResult,
  type WorkspaceLease,
} from "@hns/core";
import * as v from "valibot";
import { readBody } from "../edge/body.ts";
import { DEFAULT_LIMITS } from "../edge/limits.ts";

/** How long an issued lease stays valid unless renewed. */
const DEFAULT_LEASE_TTL_MS = 60_000;

/** The expected version that names a path with no recorded version. */
const ABSENT_VERSION = "absent";

const LEASE_ACTIONS = ["acquire", "renew", "release"] as const;
type LeaseAction = (typeof LEASE_ACTIONS)[number];

/** The closed failure codes that are not lease refusals. */
type WorkspaceRpcCode = "invalid_request" | "not_found" | "unavailable" | "internal";

/** The slice of `DurableObjectState` the Workspace uses. */
export interface WorkspaceState {
  readonly storage: DurableObjectSqliteStorage;
  blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T>;
}

/** Test seams for the clock and lease lifetime. */
export interface WorkspaceOptions {
  /** Milliseconds since the epoch; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** Lease lifetime in milliseconds; defaults to 60 seconds. */
  readonly leaseTtlMs?: number | undefined;
}

interface StoredLease {
  readonly workspaceId: string;
  readonly machineId: string;
  readonly epoch: number;
  readonly expiresAtMs: number;
}

interface LeaseIdentity {
  readonly workspaceId: string;
  readonly machineId: string;
  readonly epoch: number;
}

type AcquireOutcome =
  | { readonly ok: true; readonly lease: WorkspaceLease }
  | { readonly ok: false; readonly code: LeaseRefusal };

type ApplyOutcome =
  | { readonly ok: true; readonly result: MutationResult }
  | { readonly ok: false; readonly code: LeaseRefusal };

type RenewOutcome = AcquireOutcome;
type MutationOutcome = { readonly ok: true } | { readonly ok: false; readonly code: LeaseRefusal };

/** A row as the DO SQL binding returns it. */
type SqlValue = ArrayBuffer | string | number | null;
type Row = Record<string, SqlValue>;

const NonEmptyText = v.pipe(v.string(), v.minLength(1));
const EpochSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

const AcquireSchema = v.object({ workspaceId: NonEmptyText, machineId: NonEmptyText });
const RenewSchema = v.object({
  workspaceId: NonEmptyText,
  machineId: NonEmptyText,
  epoch: EpochSchema,
});
const ApplySchema = v.object({
  workspaceId: NonEmptyText,
  machineId: NonEmptyText,
  epoch: EpochSchema,
  operationId: OperationIdSchema,
  path: NonEmptyText,
  expectedVersion: NonEmptyText,
  version: NonEmptyText,
});

const MetaRowSchema = v.object({ value: v.string() });
const EpochTextSchema = v.pipe(
  v.string(),
  v.regex(/^(0|[1-9][0-9]*)$/u),
  v.transform((text) => Number(text)),
  v.integer(),
  v.minValue(0),
);
const LeaseRowSchema = v.object({
  workspace_id: NonEmptyText,
  machine_id: NonEmptyText,
  epoch: EpochSchema,
  expires_at_ms: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
const VersionRowSchema = v.object({ version: NonEmptyText });

/** A request that names a workspace other than the one this object serves. */
class WorkspaceIdentityError extends Error {
  constructor() {
    super("the request names a different workspace");
    this.name = "WorkspaceIdentityError";
  }
}

/**
 * Normalize a workspace-relative path for the version table.
 *
 * @param value - The path as the caller wrote it; both separators are accepted.
 * @returns The path without empty or `.` segments, or undefined when it must be refused.
 *
 * @remarks
 * This is syntactic only, mirroring the repository's workspace contract: an empty path, a
 * NUL, a POSIX-absolute path, a Windows drive letter, and any `..` segment are refused so a
 * key cannot name something outside the workspace. Whether the path resolves under the root
 * is decided by the writer that applies the file, not here.
 *
 * @internal
 */
function parsePath(value: string): string | undefined {
  if (value.length === 0 || value.includes("\0")) return undefined;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) return undefined;
  const parts = value.split(/[\\/]+/u);
  if (parts.includes("..")) return undefined;
  const normalized = parts.filter((part) => part !== "" && part !== ".").join("/");
  return normalized.length === 0 ? undefined : normalized;
}

/** The refusal a write would get under the stored lease, or undefined when it may proceed. */
function refusalFor(
  lease: StoredLease,
  request: LeaseIdentity,
  nowMs: number,
): LeaseRefusal | undefined {
  if (lease.workspaceId !== request.workspaceId) return "lease_not_held";
  if (nowMs >= lease.expiresAtMs) return "lease_expired";
  if (lease.epoch !== request.epoch) return "lease_epoch_stale";
  if (lease.machineId !== request.machineId) return "lease_not_held";
  return undefined;
}

/** A JSON response with no caching. */
function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** A typed protocol failure. */
function failure(code: WorkspaceRpcCode, message: string, status: number): Response {
  return json({ ok: false, code, message }, status);
}

/** A refusal from the closed lease vocabulary. */
function refusal(code: LeaseRefusal): Response {
  return json({ ok: false, code }, 409);
}

/**
 * Read and parse a JSON body, or return the failure to send.
 *
 * @internal
 */
async function bodyOf(
  request: Request,
): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly response: Response }
> {
  const body = await readBody(request, DEFAULT_LIMITS.maxBodyBytes);
  if (!body.ok) {
    const status = body.code === "payload_too_large" ? 413 : 415;
    return {
      ok: false,
      response: failure("invalid_request", "The request body was refused.", status),
    };
  }
  if (body.text.length === 0) {
    return { ok: false, response: failure("invalid_request", "A JSON body is required.", 400) };
  }
  try {
    return { ok: true, value: JSON.parse(body.text) };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false, response: failure("invalid_request", "The body is not JSON.", 400) };
    }
    throw error;
  }
}

/**
 * One workspace's Workspace Durable Object.
 *
 * @remarks
 * The object is addressed by `idFromName(workspaceId)` (the deploy binding arrives with the
 * Worker wiring). It is the serialization point for writes: `apply` reads the recorded
 * version, compares `expectedVersion`, and records the new version inside one
 * `storage.transaction`, so two concurrent writes to the same path cannot both pass the
 * comparison. A live lease gates every write; an expired lease or a stale epoch fails closed
 * with the core `LEASE_REFUSALS` vocabulary. Reads need no lease.
 *
 * `apply` returns `applied` or `conflict`. The `unknown` member of `MutationResult`
 * describes a write whose transport died before the outcome reached the DO; this face never
 * produces it.
 *
 * RPC face (`/rpc`):
 * - `POST /rpc/apply` — compare and record a version.
 * - `GET /rpc/read?path=` — the recorded version, or `"absent"`.
 * - `POST /rpc/lease/acquire` — issue the workspace's only lease.
 * - `POST /rpc/lease/renew` — extend the holder's lease.
 * - `POST /rpc/lease/release` — drop the holder's lease.
 *
 * The first acquisition binds the object to the `workspaceId` it carries; a later request
 * for a different workspace is refused, so one object never mixes two version tables. A second
 * `acquire` while a valid lease is held is refused with `lease_not_held`; the epoch moves
 * only when a new holder is issued the lease.
 */
export class Workspace {
  readonly #state: WorkspaceState;
  readonly #clock: () => number;
  readonly #leaseTtlMs: number;
  readonly #ready: Promise<void>;

  /**
   * @param state - The object's storage; tests provide a SQLite-backed fake.
   * @param options - Clock and lease lifetime overrides; production uses the defaults.
   * @throws RangeError when `leaseTtlMs` is not a positive integer.
   */
  constructor(state: WorkspaceState, options: WorkspaceOptions = {}) {
    const ttl = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl <= 0) {
      throw new RangeError("leaseTtlMs must be a positive integer");
    }
    this.#state = state;
    this.#clock = options.now ?? (() => Date.now());
    this.#leaseTtlMs = ttl;
    this.#ready = state.blockConcurrencyWhile(() => this.#initialize());
  }

  async #initialize(): Promise<void> {
    this.#exec(
      "CREATE TABLE IF NOT EXISTS workspace_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    this.#exec(
      "CREATE TABLE IF NOT EXISTS workspace_lease (slot INTEGER PRIMARY KEY CHECK (slot = 0), workspace_id TEXT NOT NULL, machine_id TEXT NOT NULL, epoch INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL)",
    );
    this.#exec(
      "CREATE TABLE IF NOT EXISTS workspace_version (path TEXT PRIMARY KEY, version TEXT NOT NULL)",
    );
  }

  /**
   * Handle one internal Workspace RPC request.
   *
   * @param request - A request forwarded by the Session DO or the Worker through the binding.
   * @returns A JSON response; lease refusals are 409 with a `LEASE_REFUSALS` code.
   *
   * @remarks
   * These routes are not public Worker routes. Every body and path is still parsed, so an
   * internal mistake fails as a typed 4xx instead of corrupting the version table.
   */
  async fetch(request: Request): Promise<Response> {
    try {
      await this.#ready;
    } catch {
      return failure("unavailable", "The Workspace could not be opened.", 503);
    }
    try {
      return await this.#route(request);
    } catch (error) {
      if (error instanceof WorkspaceIdentityError) {
        return failure("invalid_request", "The request names a different workspace.", 400);
      }
      console.error("workspace rpc failed", error instanceof Error ? error.name : "unknown");
      return failure("internal", "Unexpected Workspace failure.", 500);
    }
  }

  async #route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter((segment) => segment !== "");
    if (segments[0] !== "rpc") {
      return failure("not_found", "No Workspace RPC route matches this path.", 404);
    }
    const face = segments[1];
    if (face === "apply") {
      if (segments.length !== 2) {
        return failure("not_found", "No Workspace RPC route matches this path.", 404);
      }
      if (request.method !== "POST") {
        return failure("invalid_request", "Only POST is allowed here.", 405);
      }
      return await this.#apply(request);
    }
    if (face === "read") {
      if (segments.length !== 2) {
        return failure("not_found", "No Workspace RPC route matches this path.", 404);
      }
      if (request.method !== "GET") {
        return failure("invalid_request", "Only GET is allowed here.", 405);
      }
      return this.#read(url);
    }
    if (face === "lease") {
      const action = segments[2];
      if (segments.length !== 3 || !isLeaseAction(action)) {
        return failure("not_found", "No Workspace RPC route matches this path.", 404);
      }
      if (request.method !== "POST") {
        return failure("invalid_request", "Only POST is allowed here.", 405);
      }
      switch (action) {
        case "acquire":
          return await this.#acquire(request);
        case "renew":
          return await this.#renew(request);
        case "release":
          return await this.#release(request);
      }
    }
    return failure("not_found", "No Workspace RPC route matches this path.", 404);
  }

  async #acquire(request: Request): Promise<Response> {
    const body = await bodyOf(request);
    if (!body.ok) return body.response;
    const parsed = v.safeParse(AcquireSchema, body.value);
    if (!parsed.success) return failure("invalid_request", "Invalid lease input.", 400);
    const { workspaceId, machineId } = parsed.output;
    const outcome: AcquireOutcome = await this.#state.storage.transaction(async () => {
      this.#claimWorkspace(workspaceId);
      const nowMs = this.#clock();
      const held = this.#lease();
      if (held !== undefined && nowMs < held.expiresAtMs) {
        return { ok: false, code: "lease_not_held" };
      }
      const lastEpoch = Math.max(this.#lastEpoch(), held?.epoch ?? 0);
      const epoch = lastEpoch + 1;
      const expiresAtMs = nowMs + this.#leaseTtlMs;
      const next: StoredLease = { workspaceId, machineId, epoch, expiresAtMs };
      this.#setMeta("epoch", String(epoch));
      this.#storeLease(next);
      return { ok: true, lease: asLease(next) };
    });
    return outcome.ok ? json({ ok: true, lease: outcome.lease }) : refusal(outcome.code);
  }

  async #renew(request: Request): Promise<Response> {
    const body = await bodyOf(request);
    if (!body.ok) return body.response;
    const parsed = v.safeParse(RenewSchema, body.value);
    if (!parsed.success) return failure("invalid_request", "Invalid lease input.", 400);
    const outcome: RenewOutcome = await this.#state.storage.transaction(async () => {
      this.#assertWorkspace(parsed.output.workspaceId);
      const nowMs = this.#clock();
      const held = this.#lease();
      if (held === undefined) return { ok: false, code: "lease_not_held" };
      const refused = refusalFor(held, parsed.output, nowMs);
      if (refused !== undefined) return { ok: false, code: refused };
      const renewed: StoredLease = { ...held, expiresAtMs: nowMs + this.#leaseTtlMs };
      this.#storeLease(renewed);
      return { ok: true, lease: asLease(renewed) };
    });
    return outcome.ok ? json({ ok: true, lease: outcome.lease }) : refusal(outcome.code);
  }

  async #release(request: Request): Promise<Response> {
    const body = await bodyOf(request);
    if (!body.ok) return body.response;
    const parsed = v.safeParse(RenewSchema, body.value);
    if (!parsed.success) return failure("invalid_request", "Invalid lease input.", 400);
    const outcome: MutationOutcome = await this.#state.storage.transaction(async () => {
      this.#assertWorkspace(parsed.output.workspaceId);
      const nowMs = this.#clock();
      const held = this.#lease();
      if (held === undefined) return { ok: false, code: "lease_not_held" };
      const refused = refusalFor(held, parsed.output, nowMs);
      if (refused !== undefined) return { ok: false, code: refused };
      this.#deleteLease();
      return { ok: true };
    });
    return outcome.ok ? json({ ok: true }) : refusal(outcome.code);
  }

  async #apply(request: Request): Promise<Response> {
    const body = await bodyOf(request);
    if (!body.ok) return body.response;
    const parsed = v.safeParse(ApplySchema, body.value);
    if (!parsed.success) return failure("invalid_request", "Invalid apply input.", 400);
    const input = parsed.output;
    const path = parsePath(input.path);
    if (path === undefined) return failure("invalid_request", "Invalid path.", 400);
    if (input.version === ABSENT_VERSION) {
      return failure("invalid_request", "A write must record a version.", 400);
    }
    const outcome: ApplyOutcome = await this.#state.storage.transaction(async () => {
      this.#assertWorkspace(input.workspaceId);
      const nowMs = this.#clock();
      const held = this.#lease();
      if (held === undefined) return { ok: false, code: "lease_not_held" };
      const refused = refusalFor(held, input, nowMs);
      if (refused !== undefined) return { ok: false, code: refused };
      const current = this.#currentVersion(path) ?? ABSENT_VERSION;
      if (current !== input.expectedVersion) {
        return {
          ok: true,
          result: { status: "conflict", operationId: input.operationId, currentVersion: current },
        };
      }
      this.#putVersion(path, input.version);
      return {
        ok: true,
        result: { status: "applied", operationId: input.operationId, version: input.version },
      };
    });
    return outcome.ok ? json({ ok: true, result: outcome.result }) : refusal(outcome.code);
  }

  #read(url: URL): Response {
    const path = url.searchParams.get("path");
    if (path === null) return failure("invalid_request", "A path is required.", 400);
    const normalized = parsePath(path);
    if (normalized === undefined) return failure("invalid_request", "Invalid path.", 400);
    return json({
      ok: true,
      path: normalized,
      version: this.#currentVersion(normalized) ?? ABSENT_VERSION,
    });
  }

  /** Bind the object to its workspace on the first lease acquisition. */
  #claimWorkspace(workspaceId: string): void {
    const bound = this.#meta("workspace_id");
    if (bound === undefined) {
      this.#setMeta("workspace_id", workspaceId);
      return;
    }
    if (bound !== workspaceId) throw new WorkspaceIdentityError();
  }

  /** Refuse a request that names a workspace other than the one already bound. */
  #assertWorkspace(workspaceId: string): void {
    const bound = this.#meta("workspace_id");
    if (bound !== undefined && bound !== workspaceId) throw new WorkspaceIdentityError();
  }

  #lease(): StoredLease | undefined {
    const row = this.#all(
      "SELECT workspace_id, machine_id, epoch, expires_at_ms FROM workspace_lease WHERE slot = 0",
    )[0];
    if (row === undefined) return undefined;
    const parsed = v.parse(LeaseRowSchema, row);
    return {
      workspaceId: parsed.workspace_id,
      machineId: parsed.machine_id,
      epoch: parsed.epoch,
      expiresAtMs: parsed.expires_at_ms,
    };
  }

  #storeLease(lease: StoredLease): void {
    this.#exec(
      "INSERT INTO workspace_lease (slot, workspace_id, machine_id, epoch, expires_at_ms) VALUES (0, ?, ?, ?, ?) ON CONFLICT(slot) DO UPDATE SET workspace_id = excluded.workspace_id, machine_id = excluded.machine_id, epoch = excluded.epoch, expires_at_ms = excluded.expires_at_ms",
      lease.workspaceId,
      lease.machineId,
      lease.epoch,
      lease.expiresAtMs,
    );
  }

  #deleteLease(): void {
    this.#exec("DELETE FROM workspace_lease WHERE slot = 0");
  }

  #lastEpoch(): number {
    const value = this.#meta("epoch");
    return value === undefined ? 0 : v.parse(EpochTextSchema, value);
  }

  #meta(key: string): string | undefined {
    const row = this.#all("SELECT value FROM workspace_meta WHERE key = ?", key)[0];
    return row === undefined ? undefined : v.parse(MetaRowSchema, row).value;
  }

  #setMeta(key: string, value: string): void {
    this.#exec(
      "INSERT INTO workspace_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  #currentVersion(path: string): string | undefined {
    const row = this.#all("SELECT version FROM workspace_version WHERE path = ?", path)[0];
    return row === undefined ? undefined : v.parse(VersionRowSchema, row).version;
  }

  #putVersion(path: string, version: string): void {
    this.#exec(
      "INSERT INTO workspace_version (path, version) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET version = excluded.version",
      path,
      version,
    );
  }

  #exec(query: string, ...bindings: SqlValue[]): void {
    this.#state.storage.sql.exec(query, ...bindings);
  }

  #all(query: string, ...bindings: SqlValue[]): Row[] {
    return this.#state.storage.sql.exec(query, ...bindings).toArray();
  }
}

/** The contract of a lease as the Workspace hands it out. */
function asLease(lease: StoredLease): WorkspaceLease {
  return {
    workspaceId: lease.workspaceId,
    machineId: lease.machineId,
    epoch: lease.epoch,
    expiresAt: isoTimestamp(new Date(lease.expiresAtMs).toISOString()),
  };
}

/** Whether a path segment names a lease operation. */
function isLeaseAction(value: string | undefined): value is LeaseAction {
  return value !== undefined && LEASE_ACTIONS.some((action) => action === value);
}
