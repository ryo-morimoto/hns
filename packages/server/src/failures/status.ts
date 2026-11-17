/**
 * The one code-to-status table the server's faces share.
 *
 * @remarks
 * Every face (edge, gateway, files, Session RPC, Workspace RPC) answers an expected failure with
 * a closed code. The HTTP status that carries a code is decided **here only**: a face declares
 * which codes it can answer with ({@link FailureCodeOf}) and reads the row; it never passes a
 * status of its own. A code a face does not declare does not compile, and a code with no row
 * does not compile either.
 *
 * A code is spelled once for every face: `invalid_request` is what REST, the machine, and GraphQL
 * all say. GraphQL and REST mean slightly different things by it (a field's argument is wrong /
 * the HTTP request is wrong), so the `surfaces` column keeps each face's vocabulary closed while
 * the spelling stays one; `docs/observability.md` says it once.
 *
 * A GraphQL failure travels inside the result unions of a 200 response, so its row is marked
 * `transport: "graphql"` and carries no status: a union member is not an HTTP answer.
 *
 * Leases are their own closed vocabulary in `@hns/core` ({@link LEASE_REFUSALS}); they are rows
 * here because a refused write is an expected failure with a status, not a separate mapping.
 */
import { LEASE_REFUSALS } from "@hns/core";

/** The closed vocabulary of expected failure codes the server's faces answer with. */
export const FAILURE_CODES = [
  "unauthorized",
  "invalid_request",
  "forbidden",
  "not_found",
  "method_not_allowed",
  "conflict",
  "denied",
  "payload_too_large",
  "unsupported_media_type",
  "upgrade_required",
  "not_implemented",
  "budget_exceeded",
  "limit_exceeded",
  "limit_unavailable",
  "stopped",
  "unavailable",
  "timeout",
  "upstream",
  "internal",
  ...LEASE_REFUSALS,
] as const;

/** One expected failure code. */
export type FailureCode = (typeof FAILURE_CODES)[number];

/** The faces that share the table. Each declares its own subset of {@link FAILURE_CODES}. */
export const FAILURE_SURFACES = [
  "edge",
  "gateway",
  "files",
  "session-rpc",
  "workspace-rpc",
  "graphql",
] as const;

/** One face of the server. */
export type FailureSurface = (typeof FAILURE_SURFACES)[number];

/** How a face carries its failure. */
export const FAILURE_TRANSPORTS = [
  /** An HTTP response whose status is the row's status. */
  "http",
  /** A member of a GraphQL result union inside a 200 response; the row has no status. */
  "graphql",
] as const;

/** How one failure reaches the caller. */
export type FailureTransport = (typeof FAILURE_TRANSPORTS)[number];

/** One row: what carries the code, and which face emits it. */
interface FailureRow {
  /** The HTTP status of the failure, or null when the transport has no status. */
  readonly status: number | null;
  readonly transport: FailureTransport;
  /** The faces that answer with this code. */
  readonly surfaces: readonly FailureSurface[];
}

/**
 * The table: every expected failure code mapped to the one status that carries it.
 *
 * @remarks
 * Adding a code means adding a row and at least one surface; `satisfies Record<FailureCode,
 * FailureRow>` makes a missing row or a missing surface a compile error. `status` is null only
 * when the transport has no HTTP answer (`transport: "graphql"`).
 */
export const FAILURE_STATUS = {
  unauthorized: { status: 401, transport: "http", surfaces: ["edge"] },
  // REST and the files face: the HTTP request itself is wrong. GraphQL says the same word for an
  // argument of a field being wrong; neither face answers with the other's meaning.
  invalid_request: {
    status: 400,
    transport: "http",
    surfaces: ["edge", "files", "session-rpc", "workspace-rpc", "graphql"],
  },
  forbidden: { status: 403, transport: "http", surfaces: ["graphql"] },
  not_found: {
    status: 404,
    transport: "http",
    surfaces: ["edge", "gateway", "files", "session-rpc", "workspace-rpc"],
  },
  method_not_allowed: {
    status: 405,
    transport: "http",
    surfaces: ["edge", "gateway", "session-rpc", "workspace-rpc"],
  },
  conflict: { status: 409, transport: "http", surfaces: ["files", "workspace-rpc"] },
  // A definite refusal the machine decided before writing; the write did not happen.
  denied: { status: 400, transport: "http", surfaces: ["files", "workspace-rpc"] },
  payload_too_large: {
    status: 413,
    transport: "http",
    surfaces: ["edge", "gateway", "files", "session-rpc", "workspace-rpc"],
  },
  unsupported_media_type: {
    status: 415,
    transport: "http",
    surfaces: ["edge", "gateway", "files", "session-rpc", "workspace-rpc"],
  },
  upgrade_required: { status: 426, transport: "http", surfaces: ["edge"] },
  not_implemented: { status: 501, transport: "http", surfaces: ["edge"] },
  budget_exceeded: { status: 429, transport: "http", surfaces: ["gateway"] },
  // REST: the monthly limit is used up (429). GraphQL: the request is over the face's limits
  // (a union member, no status).
  limit_exceeded: { status: 429, transport: "http", surfaces: ["session-rpc", "graphql"] },
  limit_unavailable: { status: 503, transport: "http", surfaces: ["session-rpc"] },
  stopped: { status: 503, transport: "http", surfaces: ["gateway"] },
  unavailable: {
    status: 503,
    transport: "http",
    surfaces: ["edge", "gateway", "files", "session-rpc", "workspace-rpc", "graphql"],
  },
  timeout: { status: 504, transport: "http", surfaces: ["edge"] },
  upstream: { status: 502, transport: "http", surfaces: ["gateway"] },
  internal: {
    status: 500,
    transport: "http",
    surfaces: ["edge", "files", "session-rpc", "workspace-rpc"],
  },
  lease_not_held: { status: 409, transport: "http", surfaces: ["files", "workspace-rpc"] },
  lease_expired: { status: 409, transport: "http", surfaces: ["files", "workspace-rpc"] },
  lease_epoch_stale: { status: 409, transport: "http", surfaces: ["files", "workspace-rpc"] },
} as const satisfies Record<FailureCode, FailureRow>;

/**
 * The codes one face answers with.
 *
 * @remarks
 * The row's `surfaces` union is distributed first (`infer`), so `S extends` compares the bare
 * face literal: this TypeScript does not reduce a conditional whose checked type is an
 * intersection. Without the distribution a face's code type silently widens to every code.
 */
export type FailureCodeOf<S extends FailureSurface> = {
  readonly [C in FailureCode]: (typeof FAILURE_STATUS)[C]["surfaces"][number] extends infer P
    ? S extends P
      ? C
      : never
    : never;
}[FailureCode];

/**
 * The row a code answers with on one face, or null when the row has no HTTP status.
 *
 * @param surface - The face asking; the code must be one the face declares.
 * @param code - The closed failure code of that face.
 * @returns The row's status, or null when the row's transport is a GraphQL union member.
 *
 * @throws Error when the row does not declare the face, which is a table defect rather than a
 * branch a caller can recover from.
 * @internal
 */
export function failureStatusOrNull<S extends FailureSurface>(
  surface: S,
  code: FailureCodeOf<S>,
): number | null {
  const row: FailureRow = FAILURE_STATUS[code];
  if (!row.surfaces.some((declared) => declared === surface)) {
    throw new Error("the " + surface + " face does not answer with " + code);
  }
  return row.status;
}

/**
 * The HTTP status that carries one code on one face.
 *
 * @param surface - The face asking; the code must be one the face declares.
 * @param code - The closed failure code of that face.
 * @returns The row's status.
 *
 * @throws Error when the row has no HTTP status. A face that needs a status never passes such a
 * code: it is a table defect, not a branch.
 *
 * @remarks
 * The face never passes a status: this is the only place a code becomes one. A GraphQL failure
 * travels inside a result union, so `failureStatusOrNull` is what its row check reads.
 *
 * @example
 * ```ts @import.meta.vitest
 * expect(failureStatus("files", "denied")).toBe(400);
 * expect(failureStatus("edge", "timeout")).toBe(504);
 * expect(FAILURE_STATUS.limit_exceeded.surfaces).toContain("graphql");
 * ```
 */
export function failureStatus<S extends FailureSurface>(
  surface: S,
  code: FailureCodeOf<S>,
): number {
  const status = failureStatusOrNull(surface, code);
  if (status === null) {
    throw new Error("the " + surface + " face has no HTTP status for " + code);
  }
  return status;
}
