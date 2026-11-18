import { OperationIdSchema } from "@hns/core";
import {
  DEFAULT_OFFICE_LIMITS,
  OFFICE_DEADLINE_MARGIN_MS,
  officeFormatOfPath,
  officeParamsHash,
  officePathHash,
  previewStatusOfError,
  requestPreviewStatus,
  sha256Hex,
} from "@hns/core/office";
import type {
  OfficeEngineReport,
  OfficeErrorCode,
  OfficeJob,
  OfficeResult,
  PreviewRequestRefusal,
  PreviewStatus,
} from "@hns/core/office";
import * as v from "valibot";
import { OFFICE_MAX_ATTEMPTS, OFFICE_RETRY_MS } from "./office-rows.ts";

import type { OfficePreviewRow, OfficeRows, OfficeRowWrite } from "./office-rows.ts";
import { OFFICE_ROW_TTL_MS } from "./office-rows.ts";
import { officeRowDecision } from "./office-row-decision.ts";

/**
 * How long the engine probe may take before the request calls the machine unreachable (0237).
 *
 * @remarks
 * The edge answers one request in ten seconds; a mutation that waited on a down machine for
 * thirty seconds would be answered by the edge's deadline instead of by this face. Three seconds
 * is longer than a healthy probe (which reads one manifest) and short enough that a request that
 * probes **and** writes still finishes inside the edge's budget.
 */
export const OFFICE_PROBE_TIMEOUT_MS = 3_000;

/**
 * The machine's budget for one preview job, as the server clamps it (0237).
 *
 * @remarks
 * The job's \`timeoutMs\` is the contract's default, clamped to
 * \`min(job, OFFICE_ENGINE_BUDGET_MS - OFFICE_DEADLINE_MARGIN_MS)\` so the machine answers
 * \`engine_timeout\` itself rather than being cut off mid-answer (§5, §10). The engine budget is
 * the machine's documented 90 seconds; the server does not invent a second one, it applies the
 * contract's rule to the constant the contract states.
 */
export const OFFICE_ENGINE_BUDGET_MS = 90_000;

/**
 * The deadline one machine call carries (0237).
 *
 * @remarks
 * Longer than the machine's own office envelope (90 seconds plus its margins), so a call that the
 * machine answers `engine_timeout` for is answered rather than cut off here: the deadline is the
 * backstop for a machine that went silent, not the job's budget.
 */
export const OFFICE_CALL_TIMEOUT_MS = 120_000;

/** The engine probe behind {@link probeOfficeEngine}, with its deadline already applied. */
export type OfficeEngineAsk = () => Promise<OfficeEngineReport | undefined>;

/**
 * Ask the machine what engine it has, bounded by {@link OFFICE_PROBE_TIMEOUT_MS} (0237, C5).
 *
 * @param ask - The call; an answer it cannot give is undefined.
 * @returns The report, or undefined when the machine did not answer in time.
 *
 * @remarks
 * One place decides how long the probe may take, so the mutation and the `officeEngine` field
 * wait the same short time and neither can outlive the edge's ten seconds.
 */
export async function probeOfficeEngine(
  ask: OfficeEngineAsk,
): Promise<OfficeEngineReport | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), OFFICE_PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([ask().catch((): undefined => undefined), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One failure the office face answers with (§9). */
export interface OfficeFailureView {
  /** The union member's name, so one value can be read as a GraphQL result. */
  readonly __typename: "OfficeFailure";
  readonly code: OfficeErrorCode;
  readonly message: string;
}

/** One office failure, built in its one spelling. */
export function officeFailureOf(code: OfficeErrorCode, message: string): OfficeFailureView {
  return { __typename: "OfficeFailure", code, message };
}

/**
 * One preview as the GraphQL face answers it: a row's state and the URL its bytes are read at.
 *
 * @remarks
 * The type is the row's, projected for a reader: the status, the artifact's facts, and the
 * failure when there is one. \`url\` is a **session route**, built by {@link previewUrl} and
 * authorised by the cookie the session already holds; it is not a capability, and it names the
 * version it serves (§6).
 */
export interface DocumentPreviewView {
  readonly __typename: "DocumentPreview";
  readonly path: string;
  readonly version: string;
  readonly status: PreviewStatus;
  /** The route that serves the bytes, once \`ready\`; null before that. */
  readonly url: string | null;
  readonly pages: number | null;
  readonly bytes: number | null;
  readonly missingFonts: readonly string[];
  /** The engine's version that produced the preview, once \`ready\`. */
  readonly engine: string | null;
  /** When the row last changed, ISO 8601. */
  readonly generatedAt: string | null;
  /** Why the row is \`failed\`; null in every other state. */
  readonly error: OfficeFailureView | null;
}

/** What `officeEngine` answers when the machine has one (0237, §6). */
export type OfficeEngineView =
  | {
      readonly __typename: "OfficeEngineAvailable";
      readonly id: string;
      readonly version: string;
    }
  | { readonly __typename: "OfficeEngineUnavailable"; readonly reason: string };

/** One preview request, as the object receives it after the resolver's authorisation. */
export interface OfficePreviewRequest {
  readonly workspaceId: string;
  readonly path: string;
  readonly version: string;
}

/** Ask the machine what office engine it has, with a deadline of its own. */
export type OfficeEngineProbe = () => Promise<OfficeEngineProbeAnswer>;

/**
 * What a probe answered.
 *
 * @remarks
 * \`unavailable\` is "no usable answer": the machine is down, slow, or answered something that is
 * not a report. It is **not** the engine's absence: only a report that parsed as
 * \`available: false\` says the machine has no pack, and only that produces \`disabled\` (C5, C10).
 */
export type OfficeEngineProbeAnswer =
  | { readonly kind: "report"; readonly report: OfficeEngineReport }
  | { readonly kind: "unavailable" };

/** What one request answered: the row to show, and when the alarm is next due for it. */
export interface OfficeRequestAnswer {
  readonly row: OfficePreviewRow;
  /** The next alarm for this row, or undefined when nothing is left to do (a terminal row). */
  readonly nextAlarmAt: number | undefined;
}

/** What one alarm pass answered: the next alarm for the unfinished rows, or undefined. */
export interface OfficeRunAnswer {
  readonly nextAlarmAt: number | undefined;
}

/** What the face needs from the object. */
export interface OfficePreviewOptions {
  /** The rows. */
  readonly rows: OfficeRows;
  /** The clock; tests pass a fixed one. */
  readonly now: () => number;
  /**
   * The machine, as two calls: the engine probe (bounded by the face) and the job.
   *
   * @remarks
   * Unsettled when the Session has no machine to ask: a request then writes `disabled` (there is
   * no engine in this deployment), and the alarm has nothing to run.
   */
  readonly machine:
    | {
        readonly probe: OfficeEngineProbe;
        readonly job: (job: OfficeJob) => Promise<OfficeJobAnswer>;
      }
    | undefined;
  /** Say that an attempt finished, for the audit (§7). */
  readonly record?: ((record: OfficeAttemptRecord) => Promise<void>) | undefined;
  /** The probe's deadline; production keeps {@link OFFICE_PROBE_TIMEOUT_MS}, a test shortens it. */
  readonly probeTimeoutMs?: number | undefined;
}

/**
 * What one job call answered.
 *
 * @remarks
 * \`unavailable\` is "no usable answer": the machine was not reached at all. A result that parsed is
 * the job's own answer, and its \`ok: false\` member is an expected failure of the document rather
 * than of the call, which is why the two are not one union.
 */
export type OfficeJobAnswer =
  | { readonly kind: "result"; readonly result: OfficeResult }
  | { readonly kind: "unavailable"; readonly detail: string };

/** What one attempt is worth recording about itself (§7). */
export interface OfficeAttemptRecord {
  readonly jobId: string;
  readonly path: string;
  readonly version: string;
  readonly inputHash: string;
  readonly engineVersion: string | undefined;
  readonly ms: number;
  readonly outcome: PreviewStatus;
}

/**
 * A job id for one attempt.
 *
 * @returns An \`OperationId\`-shaped string.
 *
 * @remarks
 * The id names the attempt at the machine. A retry of a \`stale\` row is **not** sent with the old
 * id: the first attempt's outcome is unknown, and "ask again" is what settles it (docs/office.md
 * §3), not a replay of a job that may have run.
 */
function jobIdOf(): string {
  return v.parse(
    OperationIdSchema,
    "office-" + crypto.randomUUID().replaceAll("-", "").slice(0, 24),
  );
}

/** The machine's budget for one job: the contract's default, clamped under the machine's own. */
function jobLimits(): OfficeJob["limits"] {
  return {
    ...DEFAULT_OFFICE_LIMITS,
    timeoutMs: Math.min(
      DEFAULT_OFFICE_LIMITS.timeoutMs,
      OFFICE_ENGINE_BUDGET_MS - OFFICE_DEADLINE_MARGIN_MS,
    ),
  };
}

/**
 * The route a preview's bytes are read at (§6).
 *
 * @param row - The row whose preview it is.
 * @returns \`/api/office/preview?workspaceId=…&path=…&v=…\`, the path as a query value.
 *
 * @remarks
 * The path travels in the query, so no \`/\`-encoding rule is invented for it, and the route's
 * authorisation is the session cookie's. The route reads the artifact by the row's own
 * \`paramsHash\`, so the URL does not restate the options, and a changed default cannot make the
 * URL name an entry the row did not produce.
 */
export function previewUrl(row: OfficePreviewRow): string {
  const query = new URLSearchParams({
    workspaceId: row.workspaceId,
    path: row.path,
    v: row.version,
  });
  return "/api/office/preview?" + query.toString();
}

/**
 * One row, as the GraphQL face answers it.
 *
 * @param row - The stored row.
 * @returns The preview; \`url\` only once the bytes exist.
 *
 * @remarks
 * \`url\` is set for \`ready\` and for nothing else: a \`queued\` row has no bytes to fetch, and a
 * route call for it would be a 404 dressed as a preview. The failure is set for \`failed\` and
 * nothing else, because the other states are not failures of the job (an \`unsupported\` row is a
 * format, a \`disabled\` row is a deployment).
 */
export function documentPreviewView(row: OfficePreviewRow): DocumentPreviewView {
  return {
    __typename: "DocumentPreview",
    path: row.path,
    version: row.version,
    status: row.status,
    url: row.status === "ready" ? previewUrl(row) : null,
    pages: row.pages,
    bytes: row.bytes,
    missingFonts: [],
    engine: row.engine,
    generatedAt: new Date(row.updatedAt).toISOString(),
    error:
      row.status === "failed"
        ? officeFailureOf(row.code ?? "engine_failed", row.message ?? "The preview failed.")
        : null,
  };
}

/** The job one row asks for. */
function jobOf(row: OfficePreviewRow): OfficeJob {
  return {
    v: 1,
    id: v.parse(OperationIdSchema, jobIdOf()),
    input: {
      workspaceId: row.workspaceId,
      path: row.path,
      version: row.version,
      format: row.format,
    },
    limits: jobLimits(),
    operation: "preview",
  };
}

/** A row's terminal failure, as the alarm or the request writes it. */
function failureWrite(
  code: OfficeErrorCode,
  message: string,
  status: PreviewStatus,
  now: number,
  attempts: number,
): OfficeRowWrite {
  return {
    status,
    code,
    message,
    pages: null,
    bytes: null,
    engine: null,
    attempts,
    jobId: null,
    now,
  };
}

/**

/**
 * The office preview face of one Session object: the request, the alarm's attempts, and the rows.
 *
 * @remarks
 * The object owns this because the rows are its SQLite and the alarm is its alarm: a preview
 * outlives the request that asked for it (the edge answers in ten seconds; a conversion takes up
 * to sixty), so the state has to live somewhere that survives the request, and the only place in
 * this design is the object that already holds the Session (0237, Recommendation A).
 */
export interface OfficePreviewFace {
  /**
   * The row this request may answer, after checking it against the Session's workspace.
   *
   * @returns The row for the key, or undefined when there is none, or when the version the request
   * names is not the one the object recorded.
   */
  rowOf(
    workspaceId: string,
    path: string,
    workspaceVersion: string | undefined,
  ): Promise<OfficePreviewRow | undefined>;
  /**
   * Create (or reuse) the row for one request, without calling the machine for a job.
   *
   * @param request - The Session's workspace, the path, and the version the file has now.
   * @param probe - Asks an \`officeEngine\` report, with its own short deadline; undefined when the
   * Session has no machine to ask.
   * @returns The row, and when the alarm is next due for it.
   *
   * @remarks
   * **The mutation never runs a job.** It asks the engine one short question (does a pack exist,
   * and can it read this format), writes the row, and returns; the alarm runs the conversion. The
   * two questions it asks are exactly the two the contract makes \`disabled\` and \`unsupported\` at
   * request time (§3), and **a probe that cannot reach the machine is neither**: the row is
   * \`queued\` and the alarm's attempt is what finds the machine down (C5, C10).
   */
  request(request: OfficePreviewRequest): Promise<OfficeRequestAnswer>;
  /**
   * Run one attempt for every unfinished row of this workspace.
   *
   * @param workspaceId - The Session's workspace.
   * @returns When the alarm should ask again next, or undefined when nothing is left.
   *
   * @remarks
   * Called from the object's alarm. Each row is \`generating\` for the duration of one job, and the
   * answer is written to the row: \`ready\`, \`failed\`, or \`stale\` (C3, C6, C10). The row is what
   * the next poll reads; nothing is pushed, because the live socket is for conversations (§6).
   */
  run(workspaceId: string): Promise<OfficeRunAnswer>;
}

/**
 * Create the office preview face over one object's rows.
 *
 * @param options - The rows, the clock, the machine call, and the audit.
 * @returns The face.
 */
export function createOfficePreview(options: OfficePreviewOptions): OfficePreviewFace {
  const { rows, now } = options;

  /** The next moment an unfinished row needs the alarm, from \`at\`. */
  function armAt(remaining: readonly OfficePreviewRow[], at: number): number | undefined {
    let earliest: number | undefined;
    for (const row of remaining) {
      const candidate = row.updatedAt + (row.status === "stale" ? OFFICE_RETRY_MS : 0);
      if (earliest === undefined || candidate < earliest) earliest = candidate;
    }
    if (earliest === undefined) return undefined;
    return Math.min(Math.max(earliest, at), at + OFFICE_ROW_TTL_MS);
  }

  /** Ask for one report, treating a timeout or a throw as no answer. */
  async function probe(ask: OfficeEngineProbe): Promise<OfficeEngineProbeAnswer> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<OfficeEngineProbeAnswer>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: "unavailable" }),
        options.probeTimeoutMs ?? OFFICE_PROBE_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([
        ask().catch((): OfficeEngineProbeAnswer => ({ kind: "unavailable" })),
        deadline,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** One attempt for one row: generating, ask, settle. */
  async function attempt(row: OfficePreviewRow): Promise<void> {
    const started = now();
    const attempts = row.attempts + 1;
    // The row says it is being worked on, so a poll during a sixty-second conversion reads
    // \`generating\` rather than the \`queued\` it was asked for (C3).
    await rows.update(row.workspaceId, row.path, row.version, {
      status: "generating",
      code: row.code,
      message: row.message,
      pages: row.pages,
      bytes: row.bytes,
      engine: row.engine,
      attempts,
      jobId: row.jobId,
      now: started,
    });
    const job = jobOf(row);
    const inputHash = await sha256Hex(JSON.stringify(job));
    const machine = options.machine;
    const answer: OfficeJobAnswer =
      machine === undefined
        ? { kind: "unavailable", detail: "the session has no machine" }
        : await machine.job(job);
    const settle = async (write: OfficeRowWrite): Promise<void> => {
      await rows.update(row.workspaceId, row.path, row.version, write);
      await options.record?.({
        jobId: job.id,
        path: row.path,
        version: row.version,
        inputHash,
        engineVersion: write.engine ?? undefined,
        ms: Math.max(0, write.now - started),
        outcome: write.status,
      });
    };

    if (answer.kind === "unavailable") {
      // No usable answer: the result is unknown, and \`stale\` says exactly that. It is settled by
      // the next attempt, and answered \`failed\` only when the attempts run out (C6, C10).
      if (attempts >= OFFICE_MAX_ATTEMPTS) {
        await settle(
          failureWrite(
            "engine_unavailable",
            "The machine could not be reached for this preview.",
            "failed",
            now(),
            attempts,
          ),
        );
        return;
      }
      await settle({
        status: "stale",
        code: null,
        message: null,
        pages: null,
        bytes: null,
        engine: null,
        attempts,
        jobId: null,
        now: now(),
      });
      return;
    }

    const result = answer.result;
    if (result.ok) {
      await settle({
        status: "ready",
        code: null,
        message: null,
        pages: result.artifact.pages ?? null,
        bytes: result.artifact.bytes,
        engine: result.artifact.engine.version,
        attempts,
        jobId: job.id,
        now: now(),
      });
      return;
    }

    // The job ran and refused: a limit, a busy engine, a changed source. A *format* the pack
    // cannot read is the \`unsupported\` state and not \`failed\` (§9, B7), and the row keeps the
    // code that says so.
    await settle(
      failureWrite(
        result.error,
        result.message,
        previewStatusOfError(result.error),
        now(),
        attempts,
      ),
    );
  }

  return {
    async rowOf(workspaceId, path, workspaceVersion) {
      if (workspaceVersion === undefined) return undefined;
      return await rows.get(workspaceId, path, workspaceVersion);
    },

    async request(request) {
      const at = now();
      const probeEngine = options.machine?.probe;
      const format = officeFormatOfPath(request.path);
      const [pathHash, paramsHash] = await Promise.all([
        officePathHash(request.path),
        officeParamsHash("preview", {}),
      ]);
      const key = {
        workspaceId: request.workspaceId,
        path: request.path,
        version: request.version,
        format: format ?? "docx",
        operation: "preview" as const,
        pathHash,
        paramsHash,
      };
      const existing = await rows.get(key.workspaceId, key.path, key.version);
      const decision = officeRowDecision(existing, key.workspaceId, key.path, key.version);

      // The format is decided without the machine, so a file this build never previews costs no
      // probe; only a format the contract names asks whether the pack has it.
      let refusal: PreviewRequestRefusal | undefined =
        format === undefined ? { kind: "format" } : undefined;
      if (refusal === undefined) {
        if (probeEngine === undefined) {
          // No machine to ask at all: this deployment has no office, and the row says so rather
          // than arming an alarm for a job that cannot run.
          refusal = { kind: "engine" };
        } else {
          const answer = await probe(probeEngine);
          // Only a report that says "no engine" is \`disabled\`. No answer is not a report (C10).
          if (answer.kind === "report" && !answer.report.available) refusal = { kind: "engine" };
          if (
            answer.kind === "report" &&
            answer.report.available &&
            format !== undefined &&
            !answer.report.formats.some((candidate) => candidate === format)
          ) {
            refusal = { kind: "format" };
          }
        }
      }

      const status = requestPreviewStatus(refusal);
      const write: OfficeRowWrite =
        decision.kind === "reuse"
          ? // The row already asked for this job and has not settled: keep where it is, so a
            // second request neither queues a second job nor restarts the one in flight (C2).
            { ...decision.row, now: at }
          : status === "queued"
            ? {
                status,
                code: null,
                message: null,
                pages: null,
                bytes: null,
                engine: null,
                attempts: 0,
                jobId: null,
                now: at,
              }
            : failureWrite(
                refusal?.kind === "format" ? "unsupported_format" : "engine_unavailable",
                refusal?.kind === "format"
                  ? "This kind of file has no preview."
                  : "No office engine is installed on this machine.",
                status,
                at,
                0,
              );
      await rows.write(key, write);
      const row = await rows.get(key.workspaceId, key.path, key.version);
      if (row === undefined) throw new Error("the office row was written and cannot be read back");
      return {
        row,
        // An \`unsupported\` or \`disabled\` row has nothing to run (C5); every other state needs the
        // alarm, and that is the whole point of the mutation (C3).
        nextAlarmAt:
          row.status === "queued" || row.status === "generating" || row.status === "stale"
            ? at
            : undefined,
      };
    },

    async run(workspaceId) {
      for (const row of await rows.unsettled(workspaceId)) await attempt(row);
      return { nextAlarmAt: armAt(await rows.unsettled(workspaceId), now()) };
    },
  };
}
