import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {
  MACHINE_WRITE_UNKNOWN_REASONS,
  OperationIdSchema,
  isoTimestamp,
  type LeaseRefusal,
  type MutationResult,
  type WorkspaceLease,
} from "@hns/core";
import type { JournalOutcomeEntry } from "@hns/store";
import * as v from "valibot";
import { readBody } from "../edge/body.ts";
import { DEFAULT_LIMITS } from "../edge/limits.ts";
import { Journal, JournalWatermarkError, type JournalBucket } from "./journal.ts";
import { createSignedMachineFiles, type MachineFiles } from "./machine.ts";

/** How long an issued lease stays valid unless renewed. */
const DEFAULT_LEASE_TTL_MS = 60_000;

/** The expected version that names a path with no recorded version. */
const ABSENT_VERSION = "absent";

const LEASE_ACTIONS = ["acquire", "renew", "release"] as const;
type LeaseAction = (typeof LEASE_ACTIONS)[number];

/** The closed failure codes that are not lease refusals. */
type WorkspaceRpcCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "denied"
  | "unavailable"
  | "internal";

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
  readonly OBJECTS?: JournalBucket | undefined;
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

/** A typed protocol failure. */
function failure(code: WorkspaceRpcCode, message: string, status: number): Response {
  return json({ ok: false, code, message }, status);
}

/** A refusal from the closed lease vocabulary. */
function refusal(code: LeaseRefusal): Response {
  return json({ ok: false, code, message: "The write is refused: " + code }, 409);
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
      return failure("unavailable", "The Workspace could not be opened.", 503);
    }
    try {
      return await this.#route(request);
    } catch (error) {
      if (error instanceof WorkspaceIdentityError) {
        return failure("invalid_request", "The request names a different workspace.", 400);
      }
      if (error instanceof WorkspaceProjectError) {
        return failure("invalid_request", "The request names a different project root.", 400);
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
      return await this.#read(url, request);
    }
    if (face === "journal") {
      if (segments.length !== 3 || segments[2] !== "watermark") {
        return failure("not_found", "No Workspace RPC route matches this path.", 404);
      }
      if (request.method !== "POST") {
        return failure("invalid_request", "Only POST is allowed here.", 405);
      }
      return await this.#watermark(request);
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
    const body = await bodyOf(request);
    if (!body.ok) return body.response;
    const parsed = v.safeParse(ApplySchema, body.value);
    if (!parsed.success) return failure("invalid_request", "Invalid apply input.", 400);
    const input = parsed.output;
    const path = parsePath(input.path);
    const projectRoot = parseProjectRoot(input.projectRoot);
    if (path === undefined || projectRoot === undefined) {
      return failure("invalid_request", "Invalid path.", 400);
    }
    const content = bytesOfBase64(input.content);
    if (content === undefined) {
      return failure("invalid_request", "The content is not base64.", 400);
    }
    const gate: ApplyGate = await this.#state.storage.transaction(async () => {
      this.#claimWorkspace(input.workspaceId);
      this.#claimProject(projectRoot);
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
      return failure("unavailable", "The machine is not configured.", 503);
    }

    const appended = await this.#journal.appendIntent({
      operationId: input.operationId,
      path,
      expectedVersion: input.expectedVersion,
      body: content,
    });
    if (appended.status === "settled") return outcomeResponse(appended.entry);
    if (appended.status === "denied") {
      return failure("conflict", "The operation id is already used for another write.", 409);
    }
    const contentHash = appended.entry.body?.hash;
    if (contentHash === undefined) {
      return failure("internal", "The intent records no content.", 500);
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
      if (answer.failure === "denied") {
        const settled = await this.#journal.appendOutcome({
          path,
          result: { status: "denied", operationId: input.operationId, reason: answer.detail },
        });
        return outcomeResponse(settled.entry);
      }
      const settled = await this.#journal.appendOutcome({
        path,
        result: { status: "unknown", operationId: input.operationId, reason: "timeout" },
      });
      return outcomeResponse(settled.entry);
    }

    const result = answer.result;
    if (result.operationId !== input.operationId) {
      return failure("internal", "The machine answered a different operation.", 500);
    }
    const settled = await this.#journal.appendOutcome({
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
    });
    if (settled.entry.status === "applied") {
      const version = settled.entry.version;
      if (version === null) throw new Error("an applied outcome has no version");
      this.#putVersion(path, version);
      await this.#journal.appendEvent({
        eventKind: input.expectedVersion === ABSENT_VERSION ? "created" : "changed",
        path,
        version,
      });
    }
    return outcomeResponse(settled.entry);
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
      return failure("invalid_request", "Invalid journal watermark input.", 400);
    }
    this.#assertWorkspace(parsed.output.workspaceId);
    try {
      const written = await this.#journal.writeWatermark(parsed.output.throughSeq);
      return json({ ok: true, watermark: written.watermark, truncated: written.truncated });
    } catch (error) {
      if (error instanceof JournalWatermarkError) {
        return failure("conflict", error.message, 409);
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
    const files = this.#files;
    if (files === undefined) {
      return failure("unavailable", "The machine is not configured.", 503);
    }
    const path = parsePath(url.searchParams.get("path") ?? "");
    const projectRoot = parseProjectRoot(url.searchParams.get("projectRoot") ?? "");
    if (path === undefined || projectRoot === undefined) {
      return failure("invalid_request", "Invalid path.", 400);
    }
    const machineId: string | undefined = await this.#state.storage.transaction(async () =>
      this.#meta("machine_id"),
    );
    if (machineId === undefined) {
      return failure("unavailable", "The workspace has no machine yet.", 503);
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
      // failure, so the caller can tell "create it" from "the machine is unreachable".
      if (answer.failure === "denied") return failure("not_found", "The file cannot be read.", 404);
      return failure("unavailable", "The machine did not answer.", 503);
    }
    const version = answer.result.version;
    const externalChange: boolean = await this.#state.storage.transaction(async () => {
      this.#claimProject(projectRoot);
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
   * Bind the workspace to the machine project its first file call names.
   *
   * @param projectRoot - The project directory below the machine's ROOT.
   * @throws {WorkspaceProjectError} When the workspace is already bound to another project.
   *
   * @remarks
   * One workspace is one project: the binding keeps a later request from reading or writing a
   * sibling project on the same machine. It is recorded on the first call that passes the local
   * checks, read or write, and never moves.
   */
  #claimProject(projectRoot: string): void {
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
/** The HTTP status a recorded outcome answers with, when it is not the 200 success. */
function outcomeStatus(entry: JournalOutcomeEntry): number {
  switch (entry.status) {
    case "applied":
    case "conflict":
    case "unknown":
      return 200;
    case "denied":
      return 400;
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
    case "denied":
      return failure("denied", entry.reason ?? "denied", outcomeStatus(entry));
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
