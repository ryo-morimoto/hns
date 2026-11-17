import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {
  ABSENT_VERSION,
  CHECKPOINT_PACK_CONTENT_TYPE,
  CheckpointPrepareResultSchema,
  MACHINE_WRITE_UNKNOWN_REASONS,
  MIRROR_FAILURES,
  MIRROR_STATUSES,
  OperationIdSchema,
  isoTimestamp,
  type CheckpointPrepareResult,
  type CheckpointRecord,
  type LeaseRefusal,
  type MutationResult,
  type WorkspaceLease,
} from "@hns/core";
import type { JournalOutcomeEntry } from "@hns/store";
import { checkpointPackKey } from "@hns/workspace/objects";
import * as v from "valibot";
import {
  checkpointRecordOf,
  CheckpointRefusedError,
  initialMirror,
  nextMirror,
  packUploadAnswer,
  parseCheckpointRecord,
} from "../checkpoint/flow.ts";
import { signedHeadersOf } from "../checkpoint/agent-wire.ts";
import { BODY_HASH_HEADER, sha256Hex, verifyDeviceRequest } from "../checkpoint/signature.ts";
import { R2PackTransport, type PackBucket } from "../checkpoint/transport.ts";
import { readBody } from "../edge/body.ts";
import { DEFAULT_LIMITS } from "../edge/limits.ts";
import { failureStatus, type FailureCodeOf } from "../failures/status.ts";
import { Journal, JournalWatermarkError, type JournalBucket } from "./journal.ts";
import { createSignedMachineFiles, type MachineFiles } from "./machine.ts";

/** How long an issued lease stays valid unless renewed. */
const DEFAULT_LEASE_TTL_MS = 60_000;

const LEASE_ACTIONS = ["acquire", "renew", "release"] as const;
type LeaseAction = (typeof LEASE_ACTIONS)[number];

/** The closed failure codes of the Workspace RPC; lease refusals are rows of the same table. */
type WorkspaceRpcCode = FailureCodeOf<"workspace-rpc">;

/** The slice of `DurableObjectState` the Workspace uses. */
export interface WorkspaceState {
  readonly storage: DurableObjectSqliteStorage;
  blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T>;
}

/** Test seams for the clock, the lease lifetime, and the machine. */
export interface WorkspaceOptions {
  /** Milliseconds since the epoch; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** Lease lifetime in milliseconds; defaults to 60 seconds. */
  readonly leaseTtlMs?: number | undefined;
  /**
   * The machine the writes and reads go to; defaults to the signed client built from
   * `HNS_AGENT_URL` and `HNS_CONTROL_PLANE_KEY`.
   *
   * @remarks
   * A seam: the unit layer supplies a fake, and production supplies the bindings. When neither
   * is present the file faces fail closed (503) instead of falling back to a local write.
   */
  readonly files?: MachineFiles | undefined;
  /**
   * Where checkpoint packs go; defaults to the `OBJECTS` bucket.
   *
   * @remarks
   * A seam like `files`: the unit layer supplies a fake bucket that counts writes, production
   * supplies the R2 binding. Absent (and no `OBJECTS`) means the checkpoint path fails closed:
   * a pack endpoint answers `unavailable` instead of dropping the bytes.
   */
  readonly packs?: PackBucket | undefined;
}

/**
 * The bindings the deploy passes as the constructor's second argument.
 *
 * @remarks
 * Cloudflare constructs a Durable Object as `new Workspace(ctx, env)`, so the second argument is
 * the Worker's environment, not only test options. The object declares the one binding it reads,
 * structurally, so a fake and the real `R2Bucket` both fit; the Worker's `WorkerEnv.OBJECTS`
 * remains the edge's own type.
 */
export interface WorkspaceBindings {
  /** The bucket for journal bodies over 256KB. */
  readonly OBJECTS?: (JournalBucket & PackBucket) | undefined;
  /** The machine agent's origin (`http://127.0.0.1:<port>` in dev). */
  readonly HNS_AGENT_URL?: string | undefined;
  /**
   * base64url of the 32-byte Ed25519 control-plane seed (D100).
   *
   * @remarks
   * A Worker secret. The machine is chosen by the workspace's lease (0148's registry replaces
   * that choice); the key is what authenticates the Worker to whichever machine it calls.
   */
  readonly HNS_CONTROL_PLANE_KEY?: string | undefined;
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

type RenewOutcome = AcquireOutcome;
type MutationOutcome = { readonly ok: true } | { readonly ok: false; readonly code: LeaseRefusal };
type ApplyGate =
  | { readonly ok: true; readonly machineId: string }
  | { readonly ok: false; readonly code: LeaseRefusal };

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
  /**
   * The lease holder, when the caller is the machine proving its lease.
   *
   * @remarks
   * The Worker's own write (a browser save through the editor face) omits both this and the
   * epoch: the object knows the lease and calls the machine it is configured for. A tool call
   * from the machine presents both, so a stale epoch is refused.
   */
  machineId: v.optional(NonEmptyText),
  epoch: v.optional(EpochSchema),
  operationId: OperationIdSchema,
  /** The project below the machine's ROOT; `""` is the root itself. */
  projectRoot: v.string(),
  path: NonEmptyText,
  expectedVersion: NonEmptyText,
  /** The bytes to write, base64; the face decodes its text into this. */
  content: v.string(),
});

const WatermarkSchema = v.object({
  workspaceId: NonEmptyText,
  throughSeq: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

/** A Run id: the segment the machine's pack route also requires. */
const RunIdSchema = v.pipe(NonEmptyText, v.regex(/^[^/\s]+$/u));

const CheckpointPrepareSchema = v.object({ workspaceId: NonEmptyText, runId: RunIdSchema });
const CheckpointCompleteSchema = v.object({
  workspaceId: NonEmptyText,
  runId: RunIdSchema,
  throughSeq: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
const CheckpointMirrorSchema = v.object({
  workspaceId: NonEmptyText,
  runId: RunIdSchema,
  status: v.picklist(MIRROR_STATUSES),
  failure: v.optional(v.picklist(MIRROR_FAILURES)),
});

/** A stored checkpoint: its Run, the machine's prepare answer (JSON), and its record (JSON). */
const CheckpointRowSchema = v.object({
  run_id: NonEmptyText,
  prepare: v.string(),
  record: v.nullable(v.string()),
});

/** One Run's stored checkpoint, decoded from its row. */
interface StoredCheckpoint {
  readonly runId: string;
  /** The machine's prepare answer, as stored JSON. */
  readonly prepare: string;
  /** The checkpoint record as stored JSON, or null before `complete`. */
  readonly record: string | null;
}

/** The machine registry's device key, as the `machines` row holds it (0148). */
const MachineKeyRowSchema = v.object({ public_key: v.instance(ArrayBuffer) });

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

/** A request that names a project root other than the one this workspace is bound to. */
class WorkspaceProjectError extends Error {
  constructor() {
    super("the request names a different project root");
    this.name = "WorkspaceProjectError";
  }
}

/**
 * Parse the project root of a file request.
 *
 * @param value - The project directory below the machine's ROOT.
 * @returns The normalized names, or `""` for the ROOT itself; undefined when it must be refused.
 *
 * @remarks
 * The same syntactic rule as {@link parsePath}, plus the empty value: a workspace may serve the
 * machine's ROOT directly. This is checked here, before any machine call, for reads and writes
 * alike; the machine repeats it when it resolves the path.
 *
 * @internal
 */
function parseProjectRoot(value: string): string | undefined {
  if (value === "") return "";
  return parsePath(value);
}

/**
 * Decode the base64 content of a write.
 *
 * @param value - The base64 text from the RPC body.
 * @returns The bytes, or undefined when the text is not base64.
 *
 * @internal
 */
function bytesOfBase64(value: string): Uint8Array | undefined {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
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

/**
 * A typed protocol failure.
 *
 * @remarks
 * The status comes from the server's one table (`failures/status.ts`); the caller names the code.
 */
function failure(code: WorkspaceRpcCode | LeaseRefusal, message: string): Response {
  const body = { ok: false, code, message };
  return json(body, failureStatus("workspace-rpc", code));
}

/** A refusal from the closed lease vocabulary. */
function refusal(code: LeaseRefusal): Response {
  return failure(code, "The write is refused: " + code);
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
    // The body read names its own failure: too large is `payload_too_large` (413), a wrong media
    // type `unsupported_media_type` (415). The code is the status here, not `invalid_request`.
    return { ok: false, response: failure(body.code, "The request body was refused.") };
  }
  if (body.text.length === 0) {
    return { ok: false, response: failure("invalid_request", "A JSON body is required.") };
  }
  try {
    return { ok: true, value: JSON.parse(body.text) };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false, response: failure("invalid_request", "The body is not JSON.") };
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
 * The object also owns the workspace's Journal (`./journal.ts`): entries are appended here and
 * the checkpoint watermark truncates them. `env.OBJECTS` holds bodies over 256KB.
 *
 * A file write is the durability path of docs/durability.md §3.1: the intent is appended, the
 * **machine** re-resolves the path, recomputes the version, and replaces the file, and only then
 * is the outcome recorded and the answer sent. The version table is a cache of what the machine
 * last reported, not the authority; the machine's re-hash decides a conflict. A missing answer
 * is recorded as `unknown` and never rounded to `applied`.
 *
 * RPC face (`/rpc`):
 * - `POST /rpc/apply` — append the intent, apply it on the machine, settle the outcome.
 * - `GET /rpc/read?projectRoot=&path=` — the bytes and version from the machine, or 503.
 * - `POST /rpc/journal/watermark` — write the checkpoint watermark and truncate the Journal.
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
  readonly #journal: Journal;
  readonly #files: MachineFiles | undefined;
  /** Where packs go; undefined fails the checkpoint path closed at the RPC. */
  readonly #packs: R2PackTransport | undefined;
  /** The queue that serializes the calls which can decide the project binding. */
  #bindingQueue: Promise<void> = Promise.resolve();
  readonly #ready: Promise<void>;

  /**
   * @param state - The object's storage; tests provide a SQLite-backed fake.
   * @param options - Options in tests, the Worker environment in production.
   * @throws RangeError when `leaseTtlMs` is not a positive integer.
   */
  constructor(state: WorkspaceState, options: WorkspaceOptions & WorkspaceBindings = {}) {
    const ttl = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl <= 0) {
      throw new RangeError("leaseTtlMs must be a positive integer");
    }
    this.#state = state;
    this.#clock = options.now ?? (() => Date.now());
    this.#leaseTtlMs = ttl;
    this.#journal = new Journal(state.storage, {
      now: this.#clock,
      bucket: options.OBJECTS,
    });
    this.#files = options.files ?? machineFilesFrom(options);
    const packs = options.packs ?? options.OBJECTS;
    this.#packs = packs === undefined ? undefined : new R2PackTransport(packs);
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
    // One row per Run: the prepare answer the pack was sent for, and the record once the
    // checkpoint is complete. The pack's key lives here, never in a caller's hands.
    this.#exec(
      "CREATE TABLE IF NOT EXISTS checkpoint_run (run_id TEXT PRIMARY KEY, prepare TEXT NOT NULL, record TEXT)",
    );
    await this.#journal.ensureSchema();
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
      return failure("unavailable", "The Workspace could not be opened.");
    }
    try {
      return await this.#route(request);
    } catch (error) {
      if (error instanceof WorkspaceIdentityError) {
        return failure("invalid_request", "The request names a different workspace.");
      }
      if (error instanceof WorkspaceProjectError) {
        return failure("invalid_request", "The request names a different project root.");
      }
      if (error instanceof CheckpointRefusedError) {
        return failure(error.code, "The checkpoint was refused.");
      }
      if (error instanceof JournalWatermarkError) {
        // The truncation the checkpoint asked for would lose reconciliation evidence, which
        // is a refusal the caller can act on (complete the pending write), not a defect.
        return failure("conflict", error.message);
      }
      console.error("workspace rpc failed", error instanceof Error ? error.name : "unknown");
      return failure("internal", "Unexpected Workspace failure.");
    }
  }

  async #route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter((segment) => segment !== "");
    if (segments[0] !== "rpc") {
      return failure("not_found", "No Workspace RPC route matches this path.");
    }
    const face = segments[1];
    if (face === "apply") {
      if (segments.length !== 2) {
        return failure("not_found", "No Workspace RPC route matches this path.");
      }
      if (request.method !== "POST") {
        return failure("method_not_allowed", "Only POST is allowed here.");
      }
      return await this.#apply(request);
    }
    if (face === "read") {
      if (segments.length !== 2) {
        return failure("not_found", "No Workspace RPC route matches this path.");
      }
      if (request.method !== "GET") {
        return failure("method_not_allowed", "Only GET is allowed here.");
      }
      return await this.#read(url, request);
    }
    if (face === "journal") {
      if (segments.length !== 3 || segments[2] !== "watermark") {
        return failure("not_found", "No Workspace RPC route matches this path.");
      }
      if (request.method !== "POST") {
        return failure("method_not_allowed", "Only POST is allowed here.");
      }
      return await this.#watermark(request);
    }
    if (face === "checkpoint") {
      return await this.#checkpointRoute(request, segments);
    }
    if (face === "lease") {
      const action = segments[2];
      if (segments.length !== 3 || !isLeaseAction(action)) {
        return failure("not_found", "No Workspace RPC route matches this path.");
      }
      if (request.method !== "POST") {
        return failure("method_not_allowed", "Only POST is allowed here.");
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
    return failure("not_found", "No Workspace RPC route matches this path.");
  }

  async #acquire(request: Request): Promise<Response> {
    const body = await bodyOf(request);
    if (!body.ok) return body.response;
    const parsed = v.safeParse(AcquireSchema, body.value);
    if (!parsed.success) return failure("invalid_request", "Invalid lease input.");
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
      // The machine survives the lease: a read has no lease but still needs a target.
      this.#setMeta("machine_id", machineId);
      this.#storeLease(next);
      return { ok: true, lease: asLease(next) };
    });
    return outcome.ok ? json({ ok: true, lease: outcome.lease }) : refusal(outcome.code);
  }

  async #renew(request: Request): Promise<Response> {
    const body = await bodyOf(request);
    if (!body.ok) return body.response;
    const parsed = v.safeParse(RenewSchema, body.value);
    if (!parsed.success) return failure("invalid_request", "Invalid lease input.");
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
    if (!parsed.success) return failure("invalid_request", "Invalid lease input.");
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

  /**
   * Append the intent, apply it on the machine, and settle the outcome.
   *
   * @param request - The apply RPC: the lease identity, the attempt id, the project and path,
   * the expected version, and the bytes (base64).
   * @returns The recorded `MutationResult` (200), a lease refusal (409), `denied` for a
   * definite machine refusal (400), or `unavailable` when no answer arrived (504).
   *
   * @remarks
   * The order is the durability contract (INV-04, INV-10): the lease and the project binding
   * are checked first, then the intent is appended, and only then is the machine asked. A
   * retry sees the recorded outcome (`settled`) or the pending intent (`pending`) and never
   * appends a second intent. The machine recomputes `expectedVersion`; this object's version
   * table is only a cache, so a stale row cannot turn a real conflict into a success. No answer
   * is recorded as `unknown` and is not rounded.
   */
  async #apply(request: Request): Promise<Response> {
    return await this.#serializedByBinding(async () => await this.#applyOnce(request));
  }

  /** One apply, run under the binding queue when the workspace has no project yet. */
  async #applyOnce(request: Request): Promise<Response> {
    const body = await bodyOf(request);
    if (!body.ok) return body.response;
    const parsed = v.safeParse(ApplySchema, body.value);
    if (!parsed.success) return failure("invalid_request", "Invalid apply input.");
    const input = parsed.output;
    const path = parsePath(input.path);
    const projectRoot = parseProjectRoot(input.projectRoot);
    if (path === undefined || projectRoot === undefined) {
      return failure("invalid_request", "Invalid path.");
    }
    const content = bytesOfBase64(input.content);
    if (content === undefined) {
      return failure("invalid_request", "The content is not base64.");
    }
    const gate: ApplyGate = await this.#state.storage.transaction(async () => {
      this.#claimWorkspace(input.workspaceId);
      // Checked, not written: the binding is recorded when an applied outcome commits.
      this.#assertProject(projectRoot);
      const nowMs = this.#clock();
      const held = this.#lease();
      if (held === undefined) return { ok: false, code: "lease_not_held" };
      if (nowMs >= held.expiresAtMs) return { ok: false, code: "lease_expired" };
      if (input.epoch !== undefined && input.epoch !== held.epoch) {
        return { ok: false, code: "lease_epoch_stale" };
      }
      if (input.machineId !== undefined && input.machineId !== held.machineId) {
        return { ok: false, code: "lease_not_held" };
      }
      return { ok: true, machineId: held.machineId };
    });
    if (!gate.ok) return refusal(gate.code);
    // The lease is checked before the machine: an unwritable workspace is refused as such, and
    // a missing binding is not an intent anyone has to reconcile.
    const files = this.#files;
    if (files === undefined) {
      return failure("unavailable", "The machine is not configured.");
    }

    const appended = await this.#journal.appendIntent({
      operationId: input.operationId,
      path,
      expectedVersion: input.expectedVersion,
      body: content,
    });
    if (appended.status === "settled")
      return await this.#settledResponse(appended.entry, projectRoot);
    if (appended.status === "denied") {
      // The id names one attempt: another body under it is a refusal, not a version conflict.
      return failure("denied", "The operation id is already used for another write.");
    }
    const contentHash = appended.entry.body?.hash;
    if (contentHash === undefined) {
      return failure("internal", "The intent records no content.");
    }

    const answer = await files.write(
      {
        op: "write",
        projectRoot,
        path,
        expectedVersion: input.expectedVersion,
        operationId: input.operationId,
        content: input.content,
        contentHash,
      },
      {
        machineId: gate.machineId,
        requestId: request.headers.get("x-request-id") ?? "",
        signal: request.signal,
      },
    );

    if (!answer.ok) {
      // The code or error name, never the body or the key: enough to see which hop failed.
      console.error("workspace: machine write failed", answer.failure, answer.detail);
      if (answer.failure === "denied" || answer.failure === "too_large") {
        // The machine answers a refusal with a code from its closed vocabulary, and the Journal's
        // reason column holds exactly that list (the two are one type). An answer that reached
        // here without a code cannot settle a denial a caller can branch on.
        const reason = answer.refusal;
        if (reason === undefined) return failure("internal", "The machine refused without a code.");
        const settled = await this.#journal.settle({
          path,
          result: { status: "denied", operationId: input.operationId, reason },
        });
        return outcomeResponse(settled.entry);
      }
      const settled = await this.#journal.settle({
        path,
        result: { status: "unknown", operationId: input.operationId, reason: "timeout" },
      });
      return outcomeResponse(settled.entry);
    }

    const result = answer.result;
    if (result.operationId !== input.operationId) {
      return failure("internal", "The machine answered a different operation.");
    }
    const settled = await this.#journal.settle(
      {
        path,
        result:
          result.status === "applied"
            ? { status: "applied", operationId: input.operationId, version: result.version }
            : result.status === "conflict"
              ? {
                  status: "conflict",
                  operationId: input.operationId,
                  currentVersion: result.currentVersion,
                }
              : { status: "unknown", operationId: input.operationId, reason: result.reason },
      },
      (entry) => {
        // The ack implies these: they commit with the outcome, and a retry that finds the
        // outcome settled does not run this again.
        if (entry.status !== "applied") return;
        const version = entry.version;
        if (version === null) throw new Error("an applied outcome has no version");
        this.#bindProject(projectRoot);
        this.#putVersion(path, version);
        this.#journal.appendEventInTransaction({
          eventKind: input.expectedVersion === ABSENT_VERSION ? "created" : "changed",
          path,
          version,
        });
      },
    );
    return outcomeResponse(settled.entry);
  }

  /**
   * Route one checkpoint RPC.
   *
   * @param request - The request.
   * @param segments - The path's segments below `/rpc`.
   * @returns The answer; a refusal is a row of the server's failure table.
   *
   * @remarks
   * - `POST /rpc/checkpoint/prepare` — the machine's checkpoint, metadata only.
   * - `POST /rpc/checkpoint/:runId/pack` — a machine-signed binary pack, stored before the
   *   answer. The route's Run id is the one the machine signed, so a pack made for one Run
   *   cannot be handed to another.
   * - `POST /rpc/checkpoint/complete` — the watermark and the record, in one transaction.
   * - `POST /rpc/checkpoint/mirror` — the push's outcome, after the checkpoint was answered.
   */
  async #checkpointRoute(request: Request, segments: readonly string[]): Promise<Response> {
    const action = segments[2];
    if (segments.length === 3 && (action === "prepare" || action === "complete")) {
      if (request.method !== "POST") {
        return failure("method_not_allowed", "Only POST is allowed here.");
      }
      return action === "prepare"
        ? await this.#checkpointPrepare(request)
        : await this.#checkpointComplete(request);
    }
    if (segments.length === 3 && action === "mirror") {
      if (request.method !== "POST") {
        return failure("method_not_allowed", "Only POST is allowed here.");
      }
      return await this.#checkpointMirror(request);
    }
    if (segments.length === 4 && segments[3] === "pack" && action !== undefined) {
      if (request.method !== "POST") {
        return failure("method_not_allowed", "Only POST is allowed here.");
      }
      return await this.#checkpointPack(request, action);
    }
    return failure("not_found", "No Workspace RPC route matches this path.");
  }

  /**
   * Ask the machine for one Run's checkpoint and keep its metadata.
   *
   * @param request - The prepare RPC: the workspace and the Run.
   * @returns `{ ok: true, checkpoint, watermark }`: the machine's prepare result and the seq the
   * Journal is truncated through so far.
   *
   * @remarks
   * The answer is metadata only: the commit, the pack's key, and the sizes, which the machine
   * reports before its pack is sent. The object keeps the answer, so the pack endpoint keys the
   * pack by it (never by a caller's claim) and `complete` builds the record from it.
   *
   * A machine that did not make a checkpoint is a typed failure, never a defect and never an
   * acknowledged checkpoint: nothing is written and the caller learns the checkpoint did not
   * happen. A Run whose record is already complete answers its recorded checkpoint, so a retried
   * prepare does not ask the machine again.
   */
  async #checkpointPrepare(request: Request): Promise<Response> {
    const body = await bodyOf(request);
    if (!body.ok) return body.response;
    const parsed = v.safeParse(CheckpointPrepareSchema, body.value);
    if (!parsed.success) return failure("invalid_request", "Invalid checkpoint input.");
    const input = parsed.output;
    this.#claimWorkspace(input.workspaceId);
    const files = this.#files;
    if (files === undefined) return failure("unavailable", "The machine is not configured.");
    const machineId = this.#checkpointMachine();
    if (machineId === undefined) return failure("unavailable", "The workspace has no machine yet.");

    const stored = this.#checkpointRow(input.runId);
    if (stored !== undefined && stored.record !== null) {
      const record = parseCheckpointRecord(stored.record);
      return json({
        ok: true,
        checkpoint: prepareAnswerOf(record),
        watermark: this.#watermarkOf(),
      });
    }

    const answer = await files.checkpoint(
      { runId: input.runId },
      {
        machineId,
        requestId: request.headers.get("x-request-id") ?? "",
        signal: request.signal,
      },
    );
    if (!answer.ok) {
      // The failure and its code, never the answer's body: enough to see which hop failed.
      console.error("workspace: machine checkpoint failed", answer.failure, answer.detail);
      if (answer.failure === "unavailable") {
        return failure("unavailable", "The machine did not answer the checkpoint.");
      }
      // The machine's own refusal code is kept in the message, so a caller can tell a busy
      // machine from one that refused the Run; the status stays the definite `denied` (400).
      return failure(
        "denied",
        "The machine did not make the checkpoint: " + (answer.refusal ?? "refused"),
      );
    }
    const prepare = answer.result;
    if (prepare.runId !== input.runId || prepare.packKey !== checkpointPackKey(prepare.commit)) {
      // The answer must be the contract's: a key that is not the commit's would store a pack
      // restore never looks for.
      return failure("internal", "The machine answered a different checkpoint.");
    }
    this.#putCheckpointPrepare(prepare);
    return json({ ok: true, checkpoint: prepare, watermark: this.#watermarkOf() });
  }

  /**
   * Store one machine-signed pack under the key its prepare answer gave.
   *
   * @param request - The pack upload.
   * @param runId - The Run the route names.
   * @returns `{ ok: true, runId, packKey, receivedBytes, stored }`, or a typed failure.
   *
   * @remarks
   * The order refuses before it keeps anything. The media type and the declared length are read
   * first, so a body over the limit is refused **before a byte of it is kept**. The body is read
   * to exactly its declared length. The device signature is verified over those bytes with the
   * machine's enrolled key. The sha256 the machine signed is compared with the sha256 of the
   * bytes the object received, so neither a header nor a body changed in transit can pass. The
   * size must be the prepare answer's `packBytes`, because a differently sized pack is a
   * different pack and restore would fail. Only then does the store see the bytes, and the pack
   * is stored before the upload is acknowledged (the store, then the object).
   *
   * A pack is accepted only for a Run that prepared, so a pack cannot seed a checkpoint whose
   * commit the object does not know.
   */
  async #checkpointPack(request: Request, runId: string): Promise<Response> {
    const runIdParsed = v.safeParse(RunIdSchema, runId);
    if (!runIdParsed.success) return failure("invalid_request", "The Run id is not valid.");
    const packs = this.#packs;
    if (packs === undefined) {
      return failure("unavailable", "The checkpoint store is not configured.");
    }
    if (request.headers.get("content-type") !== CHECKPOINT_PACK_CONTENT_TYPE) {
      return failure(
        "unsupported_media_type",
        "A pack upload must be " + CHECKPOINT_PACK_CONTENT_TYPE + ".",
      );
    }
    const declared = request.headers.get("content-length");
    if (declared === null || !/^[0-9]{1,15}$/u.test(declared)) {
      return failure("invalid_request", "A pack upload must declare a content-length in bytes.");
    }
    if (Number(declared) > packs.maxBytes) {
      // The same bound the machine refuses at, read before the body: nothing partial is kept.
      return failure("payload_too_large", "The pack is larger than the checkpoint limit.");
    }
    const read = await readPackBody(request, packs.maxBytes);
    if (!read.ok) {
      return read.code === "too_large"
        ? failure("payload_too_large", "The pack is larger than the checkpoint limit.")
        : failure("invalid_request", "The pack body is not complete.");
    }
    const bytes = read.bytes;
    if (bytes.byteLength !== Number(declared)) {
      return failure("invalid_request", "The pack body does not match its content-length.");
    }
    const row = this.#checkpointRow(runIdParsed.output);
    if (row === undefined) {
      return failure("conflict", "The Run has no prepared checkpoint for this pack.");
    }
    const prepare = parsePrepareRow(row.prepare);
    const unsigned = await this.#refuseUnsignedPack(request, bytes);
    if (unsigned !== undefined) return unsigned;
    const signedHash = request.headers.get(BODY_HASH_HEADER) ?? "";
    if (signedHash !== (await sha256Hex(bytes))) {
      // The machine's inbound verifier checked the hash it signed; the object checks the same
      // hash against the bytes it holds, so neither a header nor a body changed in transit can
      // pass for the signed pack.
      return failure("unauthorized", "The pack does not carry the bytes that were signed.");
    }
    if (bytes.byteLength !== prepare.packBytes) {
      return failure("invalid_request", "The pack is not the size the checkpoint reported.");
    }
    const outcome = await packs.upload(runIdParsed.output, prepare.packKey, bytes);
    return json(
      packUploadAnswer({
        runId: runIdParsed.output,
        packKey: outcome.packKey,
        receivedBytes: bytes.byteLength,
        stored: outcome.stored,
      }),
    );
  }

  /**
   * Verify a pack's device signature, or answer the refusal.
   *
   * @param request - The pack upload, for its headers.
   * @param bytes - The body that was read.
   * @returns The failure response, or undefined when the signature verified.
   *
   * @remarks
   * The key is the machine's enrolled device key (D100), the public half of the key the machine
   * signs its requests with. The `machines` row that holds it belongs to the machine registry
   * (0148), which has not landed: the object reads the row when it exists and otherwise refuses
   * every pack. An unenrolled machine therefore cannot store a pack, and no pack is ever stored
   * unverified.
   */
  async #refuseUnsignedPack(request: Request, bytes: Uint8Array): Promise<Response | undefined> {
    const headers = signedHeadersOf(request.headers);
    if (headers === undefined) return failure("unauthorized", "The pack upload is not signed.");
    const rawKey = this.#deviceKey(headers.machineId);
    const publicKey = rawKey === undefined ? undefined : new Uint8Array(rawKey);
    if (publicKey === undefined) {
      return failure("unauthorized", "The machine has no enrolled key.");
    }
    const verified = await verifyDeviceRequest(
      { headers, method: "POST", path: requestPathOf(request), body: bytes },
      publicKey,
    );
    return verified ? undefined : failure("unauthorized", "The pack signature did not verify.");
  }

  /**
   * Complete one Run's checkpoint: move the watermark and write the record.
   *
   * @param request - The complete RPC: the workspace, the Run, and the seq the pack includes.
   * @returns `{ ok: true, checkpoint, watermark }`: the record and the seq the Journal is
   * truncated through.
   *
   * @remarks
   * The watermark and the record commit in **one transaction**, so a crash cannot leave the
   * Journal truncated without the record of what it was truncated to. That pair is what restore
   * needs; a truncated Journal with no record would be a checkpoint that cannot be resolved.
   *
   * The pack must be in the store, which is checked rather than assumed. A complete whose ack
   * was lost is answered from the record the first attempt wrote. When the watermark already
   * covers the seq but no record exists, the pack is still the proof: without it the call is
   * refused rather than acknowledged, so an acknowledgement never stands without its pack.
   */
  async #checkpointComplete(request: Request): Promise<Response> {
    const body = await bodyOf(request);
    if (!body.ok) return body.response;
    const parsed = v.safeParse(CheckpointCompleteSchema, body.value);
    if (!parsed.success) return failure("invalid_request", "Invalid checkpoint input.");
    const input = parsed.output;
    this.#assertWorkspace(input.workspaceId);
    const packs = this.#packs;
    if (packs === undefined) {
      return failure("unavailable", "The checkpoint store is not configured.");
    }
    const row = this.#checkpointRow(input.runId);
    if (row === undefined) {
      return failure("conflict", "The Run has no prepared checkpoint.");
    }
    if (row.record !== null) {
      // Already complete: the recorded checkpoint is the answer to every retry.
      return json({
        ok: true,
        checkpoint: parseCheckpointRecord(row.record),
        watermark: this.#watermarkOf(),
      });
    }
    const prepare = parsePrepareRow(row.prepare);
    const current = this.#watermarkOf();
    if (input.throughSeq < current) {
      throw new CheckpointRefusedError(
        "conflict",
        "the watermark never decreases: " + String(current),
      );
    }
    if ((await this.#hasPack(prepare.packKey)) === false) {
      throw new CheckpointRefusedError("conflict", "the pack is not in the store yet");
    }

    const mirror = initialMirror(
      this.#clock(),
      prepare.packBytes,
      prepare.maxBlobBytes,
      packs.maxBytes,
    );
    const record = checkpointRecordOf({ ...prepare, mirror });
    const written = await this.#state.storage.transaction(async () => {
      const watermark = this.#journal.writeWatermarkInTransaction(input.throughSeq);
      this.#putCheckpointRecord(input.runId, record);
      return watermark;
    });
    return json({ ok: true, checkpoint: record, watermark: written.watermark.throughSeq });
  }

  /**
   * Record the mirror state a push reached.
   *
   * @param request - The mirror RPC: the workspace, the Run, the status, and its failure.
   * @returns The updated checkpoint record, or a typed failure.
   *
   * @remarks
   * The push (0246) calls this after the checkpoint was acknowledged, so its outcome never
   * changes the checkpoint's answer. The core transition table decides whether the move is
   * allowed: `failed` may go back to `pending` on a retry, and `mirrored` and `skipped` never
   * move. The record, never the token, is what is stored.
   */
  async #checkpointMirror(request: Request): Promise<Response> {
    const body = await bodyOf(request);
    if (!body.ok) return body.response;
    const parsed = v.safeParse(CheckpointMirrorSchema, body.value);
    if (!parsed.success) return failure("invalid_request", "Invalid checkpoint input.");
    const input = parsed.output;
    this.#assertWorkspace(input.workspaceId);
    const row = this.#checkpointRow(input.runId);
    if (row === undefined || row.record === null) {
      return failure("not_found", "The Run has no completed checkpoint.");
    }
    const record = parseCheckpointRecord(row.record);
    const next = nextMirror(
      record.mirror,
      { status: input.status, failure: input.failure },
      this.#clock(),
    );
    if (next === undefined) {
      throw new CheckpointRefusedError(
        "conflict",
        "the mirror does not move from " + record.mirror.status + " to " + input.status,
      );
    }
    const updated = checkpointRecordOf({ ...record, mirror: next });
    this.#exec(
      "UPDATE checkpoint_run SET record = ? WHERE run_id = ?",
      JSON.stringify(updated),
      input.runId,
    );
    return json({ ok: true, checkpoint: updated });
  }

  /**
   * The machine a checkpoint goes to: the current lease holder, else the workspace's machine.
   *
   * @returns The machine id, or undefined when the workspace has never had one.
   *
   * @remarks
   * The lease holder first: a checkpoint belongs to the machine that is working on the
   * workspace now, and the recorded machine is the last holder, which a lease that moved has
   * made stale. When no lease is held the recorded machine is the only answer there is.
   */
  #checkpointMachine(): string | undefined {
    return this.#lease()?.machineId ?? this.#meta("machine_id");
  }

  /** The watermark's seq, or 0 before the first checkpoint. */
  #watermarkOf(): number {
    return this.#journal.watermark()?.throughSeq ?? 0;
  }

  /**
   * The machine's enrolled device key, or undefined when the registry has none.
   *
   * @param machineId - The machine the signed request names.
   * @returns The raw 32-byte Ed25519 public key, as the blob column holds it.
   *
   * @remarks
   * The row is the machine registry's (0148): `machines.public_key` is the raw key. The query
   * names the column so a database without the table fails the lookup rather than the request:
   * no row is no key, which the pack path refuses.
   */
  #deviceKey(machineId: string): ArrayBuffer | undefined {
    let row: Row | undefined;
    try {
      row = this.#all("SELECT public_key FROM machines WHERE id = ?", machineId)[0];
    } catch {
      return undefined;
    }
    if (row === undefined) return undefined;
    const parsed = v.safeParse(MachineKeyRowSchema, row);
    return parsed.success ? parsed.output.public_key : undefined;
  }

  /** The stored checkpoint row, or undefined when the Run has not prepared. */
  #checkpointRow(runId: string): StoredCheckpoint | undefined {
    const row = this.#all(
      "SELECT run_id, prepare, record FROM checkpoint_run WHERE run_id = ?",
      runId,
    )[0];
    if (row === undefined) return undefined;
    // A row this build cannot read is a refusal a caller can act on (prepare again), not a 500:
    // the checkpoint is not acknowledged from a value that did not parse.
    const parsed = v.safeParse(CheckpointRowSchema, row);
    if (!parsed.success) {
      throw new CheckpointRefusedError(
        "conflict",
        "the stored checkpoint is not readable: prepare the Run again",
      );
    }
    return {
      runId: parsed.output.run_id,
      prepare: parsed.output.prepare,
      record: parsed.output.record,
    };
  }

  /** Keep the machine's prepare answer, without replacing a finished checkpoint. */
  #putCheckpointPrepare(prepare: CheckpointPrepareResult): void {
    this.#exec(
      "INSERT INTO checkpoint_run (run_id, prepare, record) VALUES (?, ?, NULL) ON CONFLICT(run_id) DO UPDATE SET prepare = excluded.prepare WHERE checkpoint_run.record IS NULL",
      prepare.runId,
      JSON.stringify(prepare),
    );
  }

  /** Write the record once: a completed checkpoint is not rewritten. */
  #putCheckpointRecord(runId: string, record: CheckpointRecord): void {
    this.#exec(
      "INSERT INTO checkpoint_run (run_id, prepare, record) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET prepare = excluded.prepare, record = COALESCE(checkpoint_run.record, excluded.record)",
      runId,
      JSON.stringify(prepareAnswerOf(record)),
      JSON.stringify(record),
    );
  }

  /** Whether the store holds the pack under the key. */
  async #hasPack(packKey: string): Promise<boolean> {
    const packs = this.#packs;
    if (packs === undefined) return false;
    return await packs.has(packKey);
  }

  /**
   * Write the checkpoint watermark and truncate what the checkpoint absorbed.
   *
   * @remarks
   * The checkpoint flow (0154) calls this from the Worker; the object stays the serialization
   * point for the Journal. A watermark that would move backwards, or pass an intent with no
   * outcome, is refused with 409 instead of losing reconciliation evidence.
   */
  async #watermark(request: Request): Promise<Response> {
    const body = await bodyOf(request);
    if (!body.ok) return body.response;
    const parsed = v.safeParse(WatermarkSchema, body.value);
    if (!parsed.success) {
      return failure("invalid_request", "Invalid journal watermark input.");
    }
    this.#assertWorkspace(parsed.output.workspaceId);
    try {
      const written = await this.#journal.writeWatermark(parsed.output.throughSeq);
      return json({ ok: true, watermark: written.watermark, truncated: written.truncated });
    } catch (error) {
      if (error instanceof JournalWatermarkError) {
        return failure("conflict", error.message);
      }
      throw error;
    }
  }

  /**
   * Read one file from the machine.
   *
   * @param url - The read RPC's `projectRoot` and `path`.
   * @param request - The request, for its correlation id and deadline.
   * @returns The base64 bytes and their version, plus `externalChange` when the version table
   * disagreed with the machine; 503 when the machine is unreachable, never a stale value.
   *
   * @remarks
   * Reads need no lease, but they do go through this object: it owns the project binding and
   * the version table. The table is refreshed from every read, so a change made outside this
   * workspace (an agent's shell) shows up as `externalChange` and the next save conflicts.
   */
  async #read(url: URL, request: Request): Promise<Response> {
    return await this.#serializedByBinding(async () => await this.#readOnce(url, request));
  }

  /**
   * Read one file from the machine.
   *
   * @param url - The read RPC's projectRoot and path.
   * @param request - The request, for its correlation id and deadline.
   * @returns The base64 bytes and their version; 503 when the machine is unreachable.
   */
  async #readOnce(url: URL, request: Request): Promise<Response> {
    const files = this.#files;
    if (files === undefined) {
      return failure("unavailable", "The machine is not configured.");
    }
    const path = parsePath(url.searchParams.get("path") ?? "");
    const projectRoot = parseProjectRoot(url.searchParams.get("projectRoot") ?? "");
    if (path === undefined || projectRoot === undefined) {
      return failure("invalid_request", "Invalid path.");
    }
    // The binding is checked before the machine, so a sibling project never reaches it; it is
    // written only after a successful read.
    const machineId: string | undefined = await this.#state.storage.transaction(async () => {
      this.#assertProject(projectRoot);
      return this.#meta("machine_id");
    });
    if (machineId === undefined) {
      return failure("unavailable", "The workspace has no machine yet.");
    }
    const answer = await files.read(
      { path: projectRoot === "" ? path : projectRoot + "/" + path },
      {
        machineId,
        requestId: request.headers.get("x-request-id") ?? "",
        signal: request.signal,
      },
    );
    if (!answer.ok) {
      // A definite refusal means the file is absent (or unreadable); it is not a transport
      // failure, so the caller can tell "create it" from "the machine is unreachable". A file
      // beyond the read bound is its own answer, not a missing one.
      if (answer.failure === "too_large") {
        return failure("payload_too_large", "The file is larger than the read limit.");
      }
      if (answer.failure === "denied") return failure("not_found", "The file cannot be read.");
      return failure("unavailable", "The machine did not answer.");
    }
    const version = answer.result.version;
    const externalChange: boolean = await this.#state.storage.transaction(async () => {
      this.#bindProject(projectRoot);
      const previous = this.#currentVersion(path);
      if (previous !== version) this.#putVersion(path, version);
      return previous !== undefined && previous !== version;
    });
    return json({
      ok: true,
      path,
      version,
      content: answer.result.content,
      externalChange,
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

  /**
   * Answer a retry that found its operation already settled.
   *
   * @param entry - The stored outcome; it is the answer for its operation id.
   * @param projectRoot - The project the current request names.
   * @returns The recorded answer.
   *
   * @remarks
   * An applied outcome is the only one that implies a version and an event. If a record was
   * written without them (an older face, or a manual repair) the cache is filled in here, in
   * one transaction, so a retry converges. A conflict, unknown, or denied outcome needs nothing
   * beyond its own record.
   *
   * The repair emits `changed` because the outcome does not record whether the write created
   * the file; a watcher re-hashes the path anyway, so the approximation does not hide a change.
   */
  async #settledResponse(entry: JournalOutcomeEntry, projectRoot: string): Promise<Response> {
    if (entry.status !== "applied") return outcomeResponse(entry);
    await this.#state.storage.transaction(async () => {
      this.#bindProject(projectRoot);
      const version = entry.version;
      if (version === null) throw new Error("an applied outcome has no version");
      if (this.#currentVersion(entry.path) === version) return;
      this.#putVersion(entry.path, version);
      this.#journal.appendEventInTransaction({
        eventKind: "changed",
        path: entry.path,
        version,
      });
    });
    return outcomeResponse(entry);
  }

  /**
   * Run one call while the workspace has no project binding, one at a time.
   *
   * @param work - The whole call: the binding check, the machine call, and the settle.
   * @returns The call's answer.
   *
   * @remarks
   * The binding is written by the call that commits the fact justifying it (an applied
   * outcome, or a successful read), which happens near the end of the call. Without this
   * queue, two concurrent first calls could both pass the unbound check, both reach the
   * machine, and the loser's bind would roll its outcome back, leaving a pending intent that
   * blocks the checkpoint watermark. Once bound, the check is enough and no queue is taken.
   */
  async #serializedByBinding<T>(work: () => Promise<T>): Promise<T> {
    if (this.#meta("project_root") !== undefined) return await work();
    const previous = this.#bindingQueue;
    let release: () => void = () => {};
    this.#bindingQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  /**
   * Refuse a request whose project root differs from the workspace's binding.
   *
   * @param projectRoot - The project directory below the machine's ROOT.
   * @throws {WorkspaceProjectError} When the workspace is already bound to another project.
   *
   * @remarks
   * One workspace is one project: the binding keeps a later request from reading or writing a
   * sibling project on the same machine. This check never writes; the binding is recorded with
   * the first applied write or the first successful read.
   */
  #assertProject(projectRoot: string): void {
    const bound = this.#meta("project_root");
    if (bound !== undefined && bound !== projectRoot) throw new WorkspaceProjectError();
  }

  /**
   * Record the workspace's project binding, if it has none yet.
   *
   * @param projectRoot - The project directory below the machine's ROOT.
   * @throws {WorkspaceProjectError} When the workspace is already bound to another project.
   *
   * @remarks
   * Called inside the transaction that commits the fact which justifies it: an applied outcome
   * (with its version and event) or a successful read. A refusal, a conflict, an unknown, or a
   * failed read must not claim the project.
   */
  #bindProject(projectRoot: string): void {
    const bound = this.#meta("project_root");
    if (bound === undefined) {
      this.#setMeta("project_root", projectRoot);
      return;
    }
    if (bound !== projectRoot) throw new WorkspaceProjectError();
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
/**
 * The HTTP status a recorded outcome answers with.
 *
 * @remarks
 * An applied, conflicted, or undecided outcome is the operation's own record, so it answers 200
 * with a `MutationResult`; a recorded denial is a failure, and its status is the table's.
 */
function outcomeStatus(entry: JournalOutcomeEntry): number {
  switch (entry.status) {
    case "applied":
    case "conflict":
    case "unknown":
      return 200;
    case "denied":
      return failureStatus("workspace-rpc", "denied");
  }
}

/**
 * Turn a recorded outcome into the RPC answer.
 *
 * @param entry - The stored outcome, which is the authoritative answer for its operation id.
 * @returns `{ ok: true, result }` for a mutation result, or a `denied` failure carrying the
 * machine's refusal code.
 *
 * @remarks
 * A retry gets this same answer (INV-04): the recorded outcome is never recomputed, so a
 * `conflict` or an `unknown` cannot change between attempts.
 */
function outcomeResponse(entry: JournalOutcomeEntry): Response {
  switch (entry.status) {
    case "applied": {
      if (entry.version === null) throw new Error("an applied outcome has no version");
      const result: MutationResult = {
        status: "applied",
        operationId: entry.operationId,
        version: entry.version,
      };
      return json({ ok: true, result }, outcomeStatus(entry));
    }
    case "conflict": {
      if (entry.currentVersion === null) {
        throw new Error("a conflict outcome has no current version");
      }
      const result: MutationResult = {
        status: "conflict",
        operationId: entry.operationId,
        currentVersion: entry.currentVersion,
      };
      return json({ ok: true, result }, outcomeStatus(entry));
    }
    case "unknown": {
      const reason = MACHINE_WRITE_UNKNOWN_REASONS.find((candidate) => candidate === entry.reason);
      if (reason === undefined) throw new Error("an unknown outcome has no known reason");
      const result: MutationResult = { status: "unknown", operationId: entry.operationId, reason };
      return json({ ok: true, result }, outcomeStatus(entry));
    }
    case "denied": {
      // A refused-write outcome carries the machine's refusal code; a size refusal has its own
      // status so a caller can distinguish "too big" from "not allowed". Both read the table.
      if (entry.reason === "too_large") {
        return failure("payload_too_large", "The write is larger than the machine accepts.");
      }
      const body = { ok: false, code: "denied", message: entry.reason ?? "denied" };
      return json(body, outcomeStatus(entry));
    }
  }
}

/**
 * Build the production machine port from the deploy's bindings.
 *
 * @param bindings - The Worker environment the object was constructed with.
 * @returns The signed client, or undefined when the machine is not configured.
 *
 * @remarks
 * Both bindings are needed: the URL and the control-plane key (D100). A missing one is not
 * defaulted; the file faces fail closed with 503 until 0148 supplies the registry entry.
 */
function machineFilesFrom(bindings: WorkspaceBindings): MachineFiles | undefined {
  const agentUrl = bindings.HNS_AGENT_URL;
  const controlPlaneKey = bindings.HNS_CONTROL_PLANE_KEY;
  if (agentUrl === undefined || controlPlaneKey === undefined) return undefined;
  return createSignedMachineFiles({ agentUrl, controlPlaneKey });
}

/**
 * The prepare answer a completed checkpoint's record implies.
 *
 * @param record - The stored record.
 * @returns The same metadata the machine answered, with `created: false` because the checkpoint
 *   already existed when the record was written.
 *
 * @remarks
 * A retried prepare answers from the record rather than asking the machine: the commit is fixed
 * and the Run is already checkpointed, so `created` can only be false.
 */
function prepareAnswerOf(record: CheckpointRecord): CheckpointPrepareResult {
  return {
    runId: record.runId,
    ref: record.ref,
    commit: record.commit,
    packKey: record.packKey,
    objectCount: record.objectCount,
    packBytes: record.packBytes,
    maxBlobBytes: record.maxBlobBytes,
    created: false,
  };
}

/**
 * Parse a stored prepare answer.
 *
 * @param text - The JSON the row holds.
 * @returns The machine's prepare answer.
 * @throws ValiError when the row does not hold one.
 */
function parsePrepareRow(text: string): CheckpointPrepareResult {
  // The row's text is untrusted: valibot parses it, and the schema decides its shape.
  return v.parse(CheckpointPrepareResultSchema, JSON.parse(text));
}

/** The request path as the signer wrote it: the pathname and the query, in that order. */
function requestPathOf(request: Request): string {
  const url = new URL(request.url);
  return url.pathname + url.search;
}

/** What reading a pack body did. */
type PackBodyRead =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly code: "too_large" | "incomplete" };

/**
 * Read a pack body, streamed, up to the limit.
 *
 * @param request - The pack upload whose body is read.
 * @param maxBytes - The limit; a body that passes it is cut off and the read fails.
 * @returns The bytes, or the closed failure. `too_large` is a body that kept sending past the
 * limit (a declared length it does not honour); `incomplete` is a stream that ended in error.
 *
 * @remarks
 * The limit is enforced while the stream is read, so a body that lies about its length is cut
 * off instead of being kept whole. The caller compares the total with the declared length; this
 * function only guarantees that no more than the limit is ever held.
 */
async function readPackBody(request: Request, maxBytes: number): Promise<PackBodyRead> {
  const stream = request.body;
  if (stream === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, code: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, code: "incomplete" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
