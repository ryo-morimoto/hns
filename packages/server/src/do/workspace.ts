import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {
  ABSENT_VERSION,
  CHECKPOINT_PACK_CONTENT_TYPE,
  MAX_CHECKPOINT_PACK_BYTES,
  CheckpointPrepareAnswerSchema,
  CheckpointPrepareResultSchema,
  CheckpointRecordSchema,
  MACHINE_WRITE_UNKNOWN_REASONS,
  MIRROR_FAILURES,
  MIRROR_STATUSES,
  OperationIdSchema,
  isoTimestamp,
  type CheckpointPrepareAnswer,
  type CheckpointPrepareResult,
  type CheckpointRecord,
  type LeaseRefusal,
  type MutationResult,
  formatObsLog,
  type MirrorFailure,
  type MirrorStatus,
  type ObsLogEntry,
  type WorkspaceLease,
} from "@hns/core";
import { openStore } from "@hns/store";
import type {
  D1Binding,
  JournalOutcomeEntry,
  TrailChangeCreateInput,
  TrailChangeValue,
  TrailWriteRefusal,
} from "@hns/store";
import { trailLookupFor } from "@hns/store/edge";
import { mirrorRef } from "@hns/workspace/mirror";
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
import { ArtifactsRepos, artifactsRepoName, type ArtifactsBinding } from "../artifacts/repos.ts";
import {
  mirrorEnabled,
  mirrorOverrideFrom,
  mirrorSettingsOf,
  type MirrorSwitchSettings,
} from "../artifacts/kill-switch.ts";
import { mirrorObservationEntry } from "../artifacts/observability.ts";
import { signedHeadersOf } from "../checkpoint/agent-wire.ts";
import { BODY_HASH_HEADER, sha256Hex, verifyDeviceRequest } from "../checkpoint/signature.ts";
import { R2PackTransport, type PackBucket } from "../checkpoint/transport.ts";
import { checkpointMirrorReporter } from "../checkpoint/mirror-report.ts";
import { storeObserveFor } from "../obs/store.ts";
import type { DurableObjectNamespace } from "../edge/env.ts";
import { readBody } from "../edge/body.ts";
import { DEFAULT_LIMITS } from "../edge/limits.ts";
import { failureStatus, type FailureCodeOf } from "../failures/status.ts";
import { Journal, JournalWatermarkError, type JournalBucket } from "./journal.ts";
import { createSignedMachineFiles, type MachineFiles } from "./machine.ts";

/** How long an issued lease stays valid unless renewed. */
const DEFAULT_LEASE_TTL_MS = 60_000;

/** The `workspace_meta` key of the workspace's own mirror switch (`on`/`off`). */
const MIRROR_OVERRIDE_KEY = "artifacts_mirror";

const LEASE_ACTIONS = ["acquire", "renew", "release"] as const;
type LeaseAction = (typeof LEASE_ACTIONS)[number];

/** A git commit id: 40 lowercase hex characters, the only shape a checkpoint's commit has. */
const COMMIT_ID = /^[0-9a-f]{40}$/u;

/** The closed failure codes of the Workspace RPC; lease refusals are rows of the same table. */
type WorkspaceRpcCode = FailureCodeOf<"workspace-rpc">;

/** The slice of `DurableObjectState` the Workspace uses. */
export interface WorkspaceState {
  readonly storage: DurableObjectSqliteStorage;
  blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T>;
  /**
   * The runtime's keep-alive for work that outlives its response.
   *
   * @remarks
   * Cloudflare's `DurableObjectState.waitUntil` is what keeps the mirror's push and the Trail's
   * Change alive after the checkpoint's answer has been sent ({@link Workspace} calls it for the
   * work that follows an ack). It is **required**: without it the work would be started and then
   * cut off with the response, which is a silent loss of the two things the ack promised were
   * downstream — so the type refuses a state that cannot keep work alive, and a runtime that
   * lacks it fails at construction rather than dropping the work later.
   */
  waitUntil(promise: Promise<void>): void;
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
  /**
   * The Artifacts repository binding a mirror target is issued from; defaults to `ARTIFACTS`.
   *
   * @remarks
   * A seam like `packs`: the unit layer supplies a fake that records what it was asked, and
   * production supplies the Worker's binding. Absent (and no `ARTIFACTS`) means the mirror is
   * never offered a target: a run waits at `pending` instead of being handed a remote that does
   * not exist.
   */
  readonly artifacts?: ArtifactsBinding | undefined;
  /**
   * The deployment's mirror default, as a test seam; defaults to `ARTIFACTS_MIRROR`.
   *
   * @remarks
   * The kill switch's deployment half (`artifacts/kill-switch.ts`, 0249). It is the value the
   * deploy would have written; a workspace's own stored override still wins over it. Off means a
   * prepare hands out no target and no mirror is attempted, so the run keeps the state it had and
   * its review is the machine's; a checkpoint's acknowledgement never depends on the switch.
   */
  readonly artifactsMirror?: boolean | undefined;
  /**
   * Where the mirror's outcomes are observed; defaults to the `/api/metrics` path.
   *
   * @remarks
   * A seam like `artifacts`: a unit test supplies a collector, and the edge (a later change) would
   * supply the workspace's log. Absent means the decided mirror is written to the console as the
   * structured line — **never** that it is not observed or that the mirror stops.
   *
   * **Production builds it from `SESSION`** (0272n): the same factory the Session object's log
   * comes from (`obs/store.ts`'s `storeObserveFor`), so the line reaches the one observability
   * log and `/api/metrics` reads it back. There is no seam to pass it through: a Durable Object
   * is constructed as `(state, env)`, so the bindings are where production hands the object
   * everything it needs.
   */
  readonly observe?: ((entry: ObsLogEntry) => void) | undefined;
  /**
   * Where the Runs' Trails are read from, so a completed checkpoint writes its Change.
   *
   * @remarks
   * A seam like `artifacts`: production builds it from `DB` (`trailLookupFor` over the store the
   * Worker reads), and a unit test supplies a lookup. **Absent means no Change is ever written** —
   * never that a Trail is invented: a run whose Trail cannot be read is a run with no Trail, and a
   * Change needs one that a person created (0272n).
   */
  readonly trails?: TrailLookup | undefined;
  /**
   * Where a mirror push that outlives its request is reported to the object.
   *
   * @remarks
   * The push runs after the checkpoint's answer, so it cannot report through the answer's request.
   * Production builds it from `WORKSPACE` (`checkpointMirrorReporter`), which sends the result
   * back as the same `POST /rpc/checkpoint/mirror` the route already serves, addressed to this
   * object. Absent means the result is only logged and observed on the console — never that the
   * mirror stops, and never that the checkpoint changes.
   */
  readonly reportMirror?: MirrorReporter | undefined;
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
  /**
   * **Test-only seam (0239).** The machine a harness names instead of a lease.
   *
   * @remarks
   * **A deployment never sets this.** The machine is chosen by the workspace's lease (0148); a
   * read that arrives before any write has no lease to read one from, and answers "no machine
   * yet" as it always did. The office journey, which serves one machine and has no lease to
   * acquire, passes it here. The `__` prefix is the mark that this is not part of the contract
   * (`docs/invariants.md`, INV-14).
   * @internal
   */
  readonly __workspace?: { readonly machineId: string } | undefined;
  /** The bucket for journal bodies over 256KB. */
  readonly OBJECTS?: (JournalBucket & PackBucket) | undefined;
  /**
   * The Session namespace binding: the one observability log the mirror is observed through.
   *
   * @remarks
   * The object builds the obs sink from it (`storeObserveFor`), which appends over
   * `/api/events` to the Session object's event table. Absent, the object writes the console
   * line as it always did — never that it stops observing.
   */
  readonly SESSION?: DurableObjectNamespace | undefined;
  /**
   * The control database, which holds the Trails a completed checkpoint's Change is written to.
   *
   * @remarks
   * The object builds the Trail lookup from it (`trailLookupFor`). Absent, no run is linked to a
   * Trail, so no Change is written and no checkpoint fails for it.
   */
  readonly DB?: D1Binding | undefined;
  /**
   * The Workspace namespace, which the mirror reporter uses to reach this object again.
   *
   * @remarks
   * A Durable Object reaches its sibling through the binding the Worker gives it. Absent, a
   * push's result is logged and observed only — the mirror's state is the one thing left
   * unrecorded, and the checkpoint never waited for it.
   */
  readonly WORKSPACE?: DurableObjectNamespace | undefined;
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
  /**
   * The Artifacts namespace binding that holds the workspace's mirror repository.
   *
   * @remarks
   * The Worker's binding, structurally declared so a fake and the real binding both fit. Absent
   * fails the mirror closed (no target is issued) and never the checkpoint path.
   */
  readonly ARTIFACTS?: ArtifactsBinding | undefined;
  /**
   * The mirror's kill switch (`"on"`/`"off"`); absent or anything else is off.
   *
   * @remarks
   * A text binding the deploy sets. It is the **default** for every workspace; a workspace's own
   * stored override wins over it (`artifacts/kill-switch.ts`). Off stops issuing targets, so no
   * push is attempted, and the checkpoint is still made and answered.
   */
  readonly ARTIFACTS_MIRROR?: string | undefined;
}

/**
 * What the Workspace needs to know about a run's Trail: the Trail it is linked to, if any.
 *
 * @remarks
 * Narrow on purpose: the object asks one operation of the control database's Trails
 * (`trailLookupFor`), and writes nothing to D1 itself (D049).
 */
export interface TrailLookup {
  /** The Trail a run is linked to, or undefined when no Trail is. A read, for a caller asking. */
  trailForRun(runId: string): Promise<string | undefined>;
  /**
   * Open the Trail this run is linked to, as one operation.
   *
   * @returns The Trail's id and the repository to write its Change with, or undefined when the
   * run is linked to no Trail.
   *
   * @remarks
   * The link is read **inside** the operation that returns the repository, so the Trail that is
   * found is the Trail the Change is written to: one call, one store, and the object never holds a
   * repository across calls.
   */
  lookupForRun(runId: string): Promise<TrailChanges | undefined>;
}

/** The Trail a run is linked to, and the repository its Change is written with. */
export interface TrailChanges {
  /** The Trail's id. */
  readonly trailId: string;
  /** The store's Trail repository, narrowed to the two calls a Change needs. */
  readonly trails: {
    /** The Trail's latest Change, which the next Change's base comes from. */
    headChange(trailId: string): Promise<TrailChangeValue | undefined>;
    /** Add one Change; a refusal is a value, and writing it is how the Change exists. */
    addChange(
      trailId: string,
      input: TrailChangeCreateInput,
    ): Promise<TrailChangeValue | TrailWriteRefusal>;
  };
}

/**
 * How the Workspace records a mirror push that finished after its checkpoint was answered.
 *
 * @remarks
 * The push cannot report through the request that started it: that request is answered first.
 * The reporter sends the result to `POST /rpc/checkpoint/mirror` on this object from the edge
 * (`checkpointMirrorReporter`), which reaches the binding the Worker holds. A failure to report
 * is logged and the line is still observed; the mirror's state is the only thing left unrecorded,
 * and the checkpoint was never waiting for it.
 */
export type MirrorReporter = (report: MirrorReport) => Promise<void>;

/** One finished mirror push, as the reporter carries it. */
export interface MirrorReport {
  /** The workspace whose object is told; it names the repository the observation carries. */
  readonly workspaceId: string;
  readonly runId: string;
  /** The state the machine reported. */
  readonly status: "mirrored" | "failed" | "skipped";
  /** Why a `failed` push failed; absent for the other states. */
  readonly failure?: MirrorFailure | undefined;
  /** When the push was sent, in milliseconds, for the observed duration. */
  readonly startedAt: number;
  /** The correlation id of the checkpoint request the push belongs to; null when it carried none. */
  readonly requestId: string | null;
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
/** The workspace's own mirror switch; `null` removes the override. */
const MirrorSwitchSchema = v.object({
  workspaceId: NonEmptyText,
  mirror: v.nullable(v.picklist(["on", "off"])),
});

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
 * The observation sink the object is started with, from the bindings it already has.
 *
 * @param session - The SESSION namespace binding, or undefined when the deployment has none.
 * @returns `storeObserveFor`'s sink (the Session object's log), or undefined when there is no
 * binding — the object then writes its console line, as it always did.
 *
 * @remarks
 * A Durable Object is constructed as `(state, env)`, so this is how production hands the object
 * what its constructor cannot otherwise compute. The sink is the same factory the Session
 * object's own log comes from, so `artifacts.mirror` reaches the one log `/api/metrics` reads
 * (0272n).
 */
function startObserve(
  session: DurableObjectNamespace | undefined,
): ((entry: ObsLogEntry) => void) | undefined {
  return session === undefined ? undefined : storeObserveFor({ SESSION: session });
}

/**
 * The Trail lookup the object is started with, from the bindings it already has.
 *
 * @param db - The control database binding, or undefined when the deployment has none.
 * @returns The store's lookup over the store the Worker reads, or undefined without `DB`.
 *
 * @remarks
 * The lookup opens the store for the one call the Change needs (see `trailLookupFor`); the
 * object never holds a store across events.
 */
function startTrails(db: D1Binding | undefined): TrailLookup | undefined {
  return db === undefined ? undefined : trailLookupFor(() => openStore({ d1: db }));
}

/**
 * The mirror reporter the object is started with, from the bindings it already has.
 *
 * @param workspace - The WORKSPACE namespace binding, or undefined when the deployment has none.
 * @returns The sender for a push that outlives its answer, or undefined without the binding (its
 * result is then logged and observed only).
 */
function startReportMirror(
  workspace: DurableObjectNamespace | undefined,
): MirrorReporter | undefined {
  return workspace === undefined ? undefined : checkpointMirrorReporter(workspace);
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
  /** The machine the bindings name, for a read before any lease (see `__workspace`). */
  readonly #machine: { readonly machineId: string } | undefined;
  /** Where packs go; undefined fails the checkpoint path closed at the RPC. */
  readonly #packs: R2PackTransport | undefined;
  /**
   * Where a mirror target is issued from, or undefined when Artifacts is unbound.
   *
   * @remarks
   * **The switch is not folded into this value any more** (0249): a workspace can turn its mirror
   * on or off after the object was constructed, so the switch is read on every prepare
   * ({@link #mirrorSwitch}) and only an unbound binding decides here. The mirror never decides a
   * checkpoint's answer: no target means a run keeps the state it had, and its review is the
   * machine's.
   */
  readonly #mirror: ArtifactsRepos | undefined;
  /**
   * The switch as the object was constructed: the deployment's default (a test seam or
   * `ARTIFACTS_MIRROR`). The workspace's stored override is read on each decision.
   */
  readonly #switch: MirrorSwitchSettings;
  /** Where a decided mirror is observed; undefined writes only the console line. */
  readonly #observe: ((entry: ObsLogEntry) => void) | undefined;
  /**
   * Where a run's Trail is read from, or undefined when this object writes no Change.
   *
   * @remarks
   * The control database's lookup (`trailLookupFor`), never a D1 write of this object's own: the
   * Change is written by the store that also reads the link, and a run linked to no Trail is
   * never given one here.
   */
  readonly #trails: TrailLookup | undefined;
  /** Where a mirror push that outlived its request reports its result; undefined just logs it. */
  readonly #reportMirror: MirrorReporter | undefined;
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
    this.#machine = options.__workspace;
    const packs = options.packs ?? options.OBJECTS;
    this.#packs = packs === undefined ? undefined : new R2PackTransport(packs);
    const artifacts = options.artifacts ?? options.ARTIFACTS;
    // The switch is read once here for its default and again on every prepare for the workspace's
    // override; only the binding decides whether there is anything to issue a target from.
    this.#switch = mirrorSettingsOf(options, undefined);
    this.#mirror = artifacts === undefined ? undefined : new ArtifactsRepos(artifacts, this.#clock);
    // The three parts that are not bindings are built here from the bindings production already
    // gives (a Durable Object is constructed as `(state, env)`): the obs sink from SESSION (the
    // Session log's own factory), the Trail lookup from DB, and the reporter from WORKSPACE. A
    // seam still wins, so a unit test supplies any of them; what nobody provided stays undefined,
    // and each fallback is the object's own documented one.
    this.#observe = options.observe ?? startObserve(options.SESSION);
    this.#trails = options.trails ?? startTrails(options.DB);
    this.#reportMirror = options.reportMirror ?? startReportMirror(options.WORKSPACE);
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
      return await this.#checkpointRoute(request, url, segments);
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
   * - `POST /rpc/checkpoint/switch` — the workspace's own mirror switch (`on`/`off`/`null`).
   * - `GET /rpc/checkpoint/record?commit=<id>` — the recorded checkpoint of one commit, for the
   *   review's source selection (0248). A read only: no transition and no write.
   */
  async #checkpointRoute(
    request: Request,
    url: URL,
    segments: readonly string[],
  ): Promise<Response> {
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
    if (segments.length === 3 && action === "switch") {
      if (request.method !== "POST") {
        return failure("method_not_allowed", "Only POST is allowed here.");
      }
      return await this.#checkpointMirrorSwitch(request);
    }
    if (segments.length === 4 && segments[3] === "pack" && action !== undefined) {
      if (request.method !== "POST") {
        return failure("method_not_allowed", "Only POST is allowed here.");
      }
      return await this.#checkpointPack(request, action);
    }
    // The checkpoint's record, for the review: the Worker reads the recorded mirror state so a
    // diff can say which store it came from (0248). It is a read of what this object already
    // wrote, never a new decision about a checkpoint.
    if (segments.length === 3 && action === "record") {
      if (request.method !== "GET") {
        return failure("method_not_allowed", "Only GET is allowed here.");
      }
      return await this.#checkpointRecord(url);
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
      const retried = await this.#prepareAnswer(
        input.workspaceId,
        prepareAnswerOf(record),
        this.#watermarkOf(),
        record.mirror,
      );
      return json({ ok: true, ...retried });
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
    // `ok` is the RPC envelope, outside the contract's answer; the parse at the boundary is the
    // contract's, so a field it does not name cannot reach the machine.
    const withTarget = await this.#prepareAnswer(
      input.workspaceId,
      prepare,
      this.#watermarkOf(),
      initialMirror(this.#clock(), prepare.packBytes, prepare.maxBlobBytes, this.#packLimit()),
    );
    return json({ ok: true, ...withTarget });
  }

  /**
   * Build a prepare answer, with the mirror target the run may be pushed with.
   *
   * @param workspaceId - The workspace the object serves; it names the mirror's repository.
   * @param checkpoint - The machine's metadata (or the record's, on a retried prepare).
   * @param watermark - The Journal's seq at the time of the answer.
   * @param mirror - The run's mirror state; only `pending` is offered a target.
   * @returns The answer; `mirror` is absent whenever no push should be attempted.
   *
   * @remarks
   * Three things keep a target out of an answer: the switch is off or the binding is absent
   * ({@link #mirror} undefined), the run is over Artifacts' limits (`skipped`), or the state has
   * already settled. A binding failure is `repo_unavailable` and the answer simply has no
   * target: the checkpoint is already the machine's answer, and the ack must not wait for
   * Artifacts. The token is in this answer and nowhere else; nothing here writes, logs, or emits
   * it.
   *
   * **The switch is asked, not remembered.** It is read on every prepare, because a workspace can
   * turn its mirror off after the object was constructed; a run whose switch is off is answered
   * with no target and never asked about at all, so nothing is attempted, no repository is
   * looked for, and nothing about the run's state changes — a `pending` mirror stays `pending`
   * and is picked up when the switch is back on.
   */
  async #prepareAnswer(
    workspaceId: string,
    checkpoint: CheckpointPrepareResult,
    watermark: number,
    mirror: CheckpointRecord["mirror"],
  ): Promise<CheckpointPrepareAnswer> {
    const repos = this.#mirror;
    if (repos === undefined || mirror.status !== "pending" || !this.#mirrorSwitch()) {
      const answer: CheckpointPrepareAnswer = { checkpoint, watermark };
      return v.parse(CheckpointPrepareAnswerSchema, answer);
    }
    const issued = await repos.target({
      repo: artifactsRepoName(workspaceId),
      ref: mirrorRef(checkpoint.runId),
      now: this.#clock(),
    });
    if (!issued.ok) {
      // The failure code, never the binding's message or a token: enough to see which hop failed.
      console.error("workspace: the mirror target was not issued", issued.failure);
      return v.parse(CheckpointPrepareAnswerSchema, { checkpoint, watermark });
    }
    return v.parse(CheckpointPrepareAnswerSchema, {
      checkpoint,
      watermark,
      mirror: issued.target,
    });
  }

  /**
   * Whether the mirror may be attempted, right now.
   *
   * @returns True only when the workspace's stored override, or its absence and the deployment's
   * default, says on.
   *
   * @remarks
   * The one call into the kill switch (`artifacts/kill-switch.ts`); nothing else in this object
   * compares the switch's spelling. The override lives in the object's own `workspace_meta`, so a
   * workspace can stop its mirror without a redeploy, and a workspace whose row cannot be read
   * keeps the deployment's default — a broken switch is never the reason a checkpoint fails.
   */
  #mirrorSwitch(): boolean {
    let stored: string | undefined;
    try {
      stored = this.#meta(MIRROR_OVERRIDE_KEY);
    } catch (error) {
      // An unreadable row is a defect of the storage, not of the checkpoint: the default decides.
      console.error(
        "workspace: the mirror override could not be read",
        error instanceof Error ? error.name : "unknown",
      );
      stored = undefined;
    }
    return mirrorEnabled(mirrorWithOverride(this.#switch, stored));
  }

  /**
   * Set (or clear) the workspace's own mirror switch.
   *
   * @param request - The RPC body: `workspaceId` and `mirror`, `"on"`, `"off"`, or `null` to
   * remove the override and follow the deployment again.
   * @returns `{ ok: true, mirror }` with the switch in force after the write.
   *
   * @remarks
   * The override is the workspace half of the kill switch (U-02). Writing it never touches a
   * checkpoint: existing runs keep the mirror state they already have, so turning the mirror off
   * loses no data and turning it back on lets a `pending` run prepare a target again.
   */
  async #checkpointMirrorSwitch(request: Request): Promise<Response> {
    const body = await bodyOf(request);
    if (!body.ok) return body.response;
    const parsed = v.safeParse(MirrorSwitchSchema, body.value);
    if (!parsed.success) return failure("invalid_request", "Invalid mirror switch input.");
    const input = parsed.output;
    this.#claimWorkspace(input.workspaceId);
    if (input.mirror === null) {
      this.#exec("DELETE FROM workspace_meta WHERE key = ?", MIRROR_OVERRIDE_KEY);
    } else {
      this.#setMeta(MIRROR_OVERRIDE_KEY, input.mirror);
    }
    return json({ ok: true, mirror: this.#mirrorSwitch() });
  }

  /**
   * Observe one decided mirror.
   *
   * @param workspaceId - The workspace the mirror belongs to; it names the observed repository.
   * @param status - The state the Worker recorded.
   * @param failure - The failure a `failed` state carries.
   * @param startedAt - When the push was attempted, in milliseconds, for the duration; undefined
   * when nothing was attempted.
   * @param requestId - The correlation id of the reporting request.
   *
   * @remarks
   * **One entry per decided mirror, always** — on the `do` hop, carrying the state, the failure
   * code, the repository's name, and the push's duration, never the remote and never a token.
   * Where it goes is {@link #observe}: the workspace's log when the object was built with one
   * (`observe`, the edge's sink), otherwise the console as the same structured line. An
   * observation never changes the answer: a sink that throws is logged and the line still reaches
   * the console, exactly like the Session's log.
   */
  #observeMirror(
    workspaceId: string,
    status: MirrorStatus,
    failure: MirrorFailure | undefined,
    startedAt: number | undefined,
    requestId: string | null,
  ): void {
    const now = this.#clock();
    const entry = mirrorObservationEntry({
      repo: artifactsRepoName(workspaceId),
      status,
      failure,
      durationMs: startedAt === undefined ? undefined : Math.max(0, now - startedAt),
      requestId,
      now,
    });
    // **One line per decided mirror, always.** With a sink the line goes to the workspace's log
    // (`/api/metrics` reads it back); without one — which is every Worker today, because the edge
    // does not hand the object an obs sink yet — it goes to the console as the same structured
    // entry every other hop writes. A sink that throws is logged and the line still reaches the
    // console: the outcome is never silently lost.
    const observe = this.#observe;
    if (observe !== undefined) {
      try {
        observe(entry);
        return;
      } catch (error) {
        console.error(
          "workspace: the mirror observation was not written",
          error instanceof Error ? error.name : "unknown",
        );
      }
    }
    console.log(formatObsLog(entry));
  }

  /** The pack limit the mirror's initial state reads; the contract's 64 MiB when unbound. */
  #packLimit(): number {
    return this.#packs?.maxBytes ?? MAX_CHECKPOINT_PACK_BYTES;
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
    const answer = json({ ok: true, checkpoint: record, watermark: written.watermark.throughSeq });
    // **After the acknowledgement.** The checkpoint is complete and its answer is built; the two
    // things that follow are downstream of it and neither can change it: the Trail's Change (it is
    // written only because the checkpoint succeeded) and the mirror's push (0245: a failed push
    // never fails the ack). Both are reached through `waitUntil`, so the runtime keeps them alive
    // after this response while the caller's `fetch` receives the answer without waiting.
    const requestId = request.headers.get("x-request-id");
    this.#afterAnswer(() => this.#writeTrailChange(input.workspaceId, record));
    if (record.mirror.status === "pending" && this.#mirrorSwitch()) {
      this.#afterAnswer(() => this.#pushMirror(input.workspaceId, input.runId, record, requestId));
    }
    return answer;
  }
  /**
   * Run work that belongs after the answer, without making the caller wait for it.
   *
   * @param work - The work; its failure is logged, never raised at a request.
   *
   * @remarks
   * The Workspace object is constructed with the Durable Object state, so `waitUntil` is the
   * runtime's own: the work continues in the isolate after the response is sent, which is how the
   * mirror's push can take seconds while the checkpoint's ack does not. The state is required to
   * have it (the constructor refuses one that does not), so there is no path where the work is
   * started and nobody keeps it alive.
   */
  #afterAnswer(work: () => Promise<void>): void {
    const running = work().catch((error: Error) => {
      console.error(
        "workspace: work after the checkpoint answer failed",
        error instanceof Error ? error.name : "unknown",
      );
    });
    this.#state.waitUntil(running);
  }

  /**
   * Write the Change of a run whose Trail it is linked to — and nothing when it is linked to none.
   *
   * @param workspaceId - The workspace the checkpoint belongs to; it is the Change's workspace.
   * @param record - The completed checkpoint: its Run and its commit.
   *
   * @remarks
   * This is the production writer `TrailChange` did not have (0232 / 0248): **the checkpoint's
   * head commit, one row**, written because the checkpoint succeeded. The Change is `base..head`,
   * and the base is the head commit of the Trail's latest Change, so consecutive Runs of one Trail
   * form a chain of `base..head` pairs (which is the diff a review reads).
   *
   * **A run linked to no Trail gets no Change, and no Trail is created for it.** The only question
   * asked is `lookupForRun`; a run whose answer is undefined is finished as far as the Trail is
   * concerned. A Trail with no Change yet has no head to take a base from (the checkpoint's
   * metadata does not name the commit the run started at), so its first Change is not written and
   * the log says why: a Change whose base equals its head is refused by the store, and inventing a
   * base would be a diff nobody can read. A Trail whose head Change already names this commit is
   * left alone, so a retried complete writes one row.
   *
   * Every failure here is logged and swallowed: the checkpoint is complete whatever the Trail does,
   * and a Trail the store refuses is not a reason for a checkpoint to be answered differently.
   */
  async #writeTrailChange(workspaceId: string, record: CheckpointRecord): Promise<void> {
    const trails = this.#trails;
    if (trails === undefined) return;
    try {
      const found = await trails.lookupForRun(record.runId);
      // No Trail linked to this run: no Change, and no Trail is created for it.
      if (found === undefined) return;
      const { trailId, trails: changes } = found;
      const head = await changes.headChange(trailId);
      if (head === undefined) {
        console.error("workspace: the Trail has no Change to take a base from", trailId);
        return;
      }
      if (head.head_commit === record.commit) return;
      const added = await changes.addChange(trailId, {
        workspaceId,
        baseCommit: head.head_commit,
        headCommit: record.commit,
        runId: record.runId,
      });
      // A typed refusal is logged by kind alone, never by the commits a person did not ask about.
      if (added.refused) console.error("workspace: the Trail's Change was refused", added.kind);
    } catch (error) {
      console.error(
        "workspace: the Trail's Change could not be written",
        error instanceof Error ? error.name : "unknown",
      );
    }
  }

  /**
   * Push a completed checkpoint to Artifacts once, and report what the machine answered.
   *
   * @param workspaceId - The workspace, which names the mirror's repository.
   * @param runId - The Run the checkpoint belongs to.
   * @param record - The completed checkpoint, with the commit the ref must land on.
   * @param requestId - The correlation id of the checkpoint request.
   *
   * @remarks
   * The transport is the machine's own signed route (0246): the target travels in one signed
   * request and the machine pushes with git, so the Worker never holds the bytes. The target is
   * issued here, after the ack, exactly as the prepare answer issues it — the push belongs to the
   * checkpoint, not to a caller, so it is never read from a request.
   *
   * Every outcome goes to `#reportMirror`, which is the edge's `POST /rpc/checkpoint/mirror`
   * sender: the transition table and the binding's read-back are the same ones a report from
   * anywhere goes through, so `mirrored` is still the Worker's confirmation and not the machine's
   * claim. Nothing here throws and nothing here changes the checkpoint: a push that cannot start
   * is reported as `failed` with the closed word that explains it.
   */
  async #pushMirror(
    workspaceId: string,
    runId: string,
    record: CheckpointRecord,
    requestId: string | null,
  ): Promise<void> {
    const report = this.#reportMirror;
    const files = this.#files;
    const repos = this.#mirror;
    const machineId = this.#checkpointMachine();
    if (
      report === undefined ||
      files === undefined ||
      files.mirror === undefined ||
      repos === undefined ||
      machineId === undefined
    ) {
      // Nothing to push with: the checkpoint is complete and the mirror stays `pending`, which
      // says exactly that no push happened. The edge supplies the machine wire and the reporter;
      // a deployment without them has nothing to push and nothing to report.
      return;
    }
    const startedAt = this.#clock();
    const issued = await repos.target({
      repo: artifactsRepoName(workspaceId),
      ref: mirrorRef(runId),
      now: startedAt,
    });
    if (!issued.ok) {
      console.error("workspace: the mirror target was not issued", issued.failure);
      await this.#reportPush(report, {
        workspaceId,
        runId,
        status: "failed",
        failure: issued.failure,
        startedAt,
        requestId,
      });
      return;
    }
    const answer = await files.mirror(
      { runId, commit: record.commit, target: issued.target },
      // The request's own signal is already over by the time this runs: the push is bounded by
      // the machine's deadline, not by a request nobody waits for.
      { machineId, requestId: requestId ?? "", signal: new AbortController().signal },
    );
    if (!answer.ok) {
      // The refusal code or the fixed phrase, never the body: enough to see which hop failed.
      console.error("workspace: the mirror push did not answer", answer.failure, answer.detail);
      await this.#reportPush(report, {
        workspaceId,
        runId,
        status: "failed",
        failure: answer.failure === "refused" ? "push_rejected" : "network",
        startedAt,
        requestId,
      });
      return;
    }
    await this.#reportPush(report, {
      workspaceId,
      runId,
      status: answer.status,
      failure: answer.status === "failed" ? answer.failure : undefined,
      startedAt,
      requestId,
    });
  }

  /** Send one push result to the reporter; a failure is logged and observed, never raised. */
  async #reportPush(report: MirrorReporter, value: MirrorReport): Promise<void> {
    try {
      await report(value);
    } catch (error) {
      console.error(
        "workspace: the mirror report was not sent",
        error instanceof Error ? error.name : "unknown",
      );
      // The state the record could not take is still observed: the same entry the route would
      // have written, so a broken reporter does not hide the push.
      this.#observeMirror(
        value.workspaceId,
        value.status,
        value.failure,
        value.startedAt,
        value.requestId,
      );
    }
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
    const startedAt = this.#clock();
    const requestId = request.headers.get("x-request-id");
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
    if (input.status === "mirrored") {
      // The Worker reads the ref back itself: a machine that says "mirrored" is not the proof.
      const mirror = this.#mirror;
      const record = parseCheckpointRecord(row.record);
      if (mirror === undefined) {
        return failure("unavailable", "The Artifacts mirror is not configured.");
      }
      const held = await mirror.confirm(
        {
          repo: artifactsRepoName(input.workspaceId),
          ref: mirrorRef(input.runId),
          commit: record.commit,
        },
        // The RPC's record keeps the binding's own failure word for a repository that is not
        // there (`repo_unavailable`), while the absent `ref` below is the push not landing.
        { absentRepository: "failure" },
      );
      if (held.ok) {
        // A re-check that finds the commit settles the mirror even from `failed`: the push
        // landed and its confirmation was lost, which is one move in the transition table and
        // not a second push.
        const settled = nextMirror(record.mirror, { status: "mirrored" }, this.#clock());
        if (settled !== undefined) {
          const updated = checkpointRecordOf({ ...record, mirror: settled });
          this.#exec(
            "UPDATE checkpoint_run SET record = ? WHERE run_id = ?",
            JSON.stringify(updated),
            input.runId,
          );
          this.#observeMirror(input.workspaceId, "mirrored", undefined, startedAt, requestId);
          return json({ ok: true, checkpoint: updated });
        }
        // Already terminal: the recorded state is the answer, and the mirror was observed when it
        // was recorded, so a repeated report does not count twice.
        return json({ ok: true, checkpoint: record });
      }
      // The refusal keeps why: the binding's own failure code, or the closed word for a push
      // that is not at the ref. `unsupported` is never guessed here: a ref that is not there is
      // `push_rejected`, and a binding that could not answer is what it said.
      const refusal = "absence" in held ? "push_rejected" : held.failure;
      const failed = nextMirror(
        record.mirror,
        { status: "failed", failure: refusal },
        this.#clock(),
      );
      if (failed !== undefined) {
        this.#exec(
          "UPDATE checkpoint_run SET record = ? WHERE run_id = ?",
          JSON.stringify(checkpointRecordOf({ ...record, mirror: failed })),
          input.runId,
        );
        this.#observeMirror(input.workspaceId, "failed", refusal, startedAt, requestId);
      }
      throw new CheckpointRefusedError(
        "conflict",
        "the commit is not confirmed at the mirror's ref (" + refusal + ")",
      );
    }
    const record = parseCheckpointRecord(row.record);
    const next = nextMirror(
      record.mirror,
      { status: input.status, failure: input.failure },
      this.#clock(),
    );
    if (next === undefined) {
      if (record.mirror.status === input.status) {
        // The same state again, after an answer was lost: the recorded state is the answer, so a
        // retried report is idempotent instead of a conflict the caller has to interpret. A
        // `failed` row keeps its failure only when the retry names the same one; a different
        // reason is a conflict, because it would rewrite why the mirror failed.
        if (record.mirror.failure === input.failure) return json({ ok: true, checkpoint: record });
      }
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
    if (next.status !== "pending") {
      this.#observeMirror(input.workspaceId, next.status, next.failure, startedAt, requestId);
    }
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

  /**
   * The recorded checkpoint of one commit, for the review's source selection (0248).
   *
   * @param url - The read RPC's `commit` parameter.
   * @returns `{ ok: true, checkpoint }` with the stored record, or `not_found` when no completed
   * checkpoint of this object names that commit.
   *
   * @remarks
   * **A read, and only a read.** The review asks "what does the mirror state of this commit say?"
   * so a diff can name the store it was read from; a question that moved a mirror state would let
   * a page change what a push reports. A Run that prepared but did not complete has no record and
   * is not this route's answer; the commit is the key because a Change names commits, not Runs.
   */
  async #checkpointRecord(url: URL): Promise<Response> {
    const commit = url.searchParams.get("commit") ?? "";
    if (!COMMIT_ID.test(commit)) {
      return failure("invalid_request", "The commit is not a commit id.");
    }
    const rows = this.#all("SELECT record FROM checkpoint_run WHERE record IS NOT NULL");
    for (const row of rows) {
      const stored = v.safeParse(v.object({ record: v.string() }), row);
      if (!stored.success) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(stored.output.record);
      } catch {
        // A row this build cannot parse is not this commit's record; it is skipped rather than
        // failing the read, exactly as a row whose shape does not parse is. A review asking for
        // a commit must not answer 500 because another Run's row is corrupt.
        continue;
      }
      const record = v.safeParse(CheckpointRecordSchema, raw);
      if (!record.success) continue;
      if (record.output.commit === commit) return json({ ok: true, checkpoint: record.output });
    }
    return failure("not_found", "No completed checkpoint of this workspace names that commit.");
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
      return this.#meta("machine_id") ?? this.#machine?.machineId;
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
/**
 * The switch's settings with the workspace's stored override applied.
 *
 * @param deployment - The settings the object was constructed with (the deployment's default).
 * @param stored - The stored override row's text, or undefined when the workspace has none.
 * @returns The deployment's default with the override when the row names one.
 *
 * @remarks
 * A stored value this build does not know is no override at all ({@link mirrorOverrideFrom}), so a
 * row written by a newer build cannot freeze a workspace on a switch this one cannot read.
 */
function mirrorWithOverride(
  deployment: MirrorSwitchSettings,
  stored: string | undefined,
): MirrorSwitchSettings {
  const override = mirrorOverrideFrom(stored);
  return override === undefined ? deployment : { ...deployment, override };
}

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
