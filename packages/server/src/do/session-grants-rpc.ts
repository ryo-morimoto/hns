import * as v from "valibot";
import { ToolManifestSchema, type SignedGrant, type ToolManifest } from "@hns/core/capability";
import { readBody } from "../edge/body.ts";
import type { GrantIssue, GrantPlane } from "./session-grants.ts";
import type { GrantRequester } from "./grant-ledger.ts";

/**
 * The grant route of the internal Session RPC: `POST /rpc/grants` (0224, `docs/capability.md` §10).
 *
 * @remarks
 * The Worker's `requestGrant` mutation reads the workspace's active policy revision from D1,
 * verifies the caller and the machine, and forwards this body to the session object through the
 * `SESSION` binding. The body carries what the object cannot read for itself:
 *
 * - the **snapshot** the grant is issued under (`{revision, hash, document}`), which the object never
 *   fetches (it does not read D1, D049);
 * - the **request** (workspace, session, machine, tool, version, manifest hash, byte bound);
 * - the **manifests** the Worker knows, so the issuer can check that the request's hash is a
 *   manifest of the right tool and version (a hash cannot be inverted);
 * - **who asks**: a human subject, or an agent's run;
 * - optional `revokeRun`: the run whose grants the Worker wants revoked (the run ended).
 *
 * The answer is the signed grant **to the Worker only** (it is what the agent hands the machine),
 * or the denial. No route, header, or log line carries the grant: an HTTP face that forwards it is
 * the Worker's own, which answers the signed-in person and whose responses are not logged.
 */

/** The requester shape on the wire. */
const RequesterSchema: v.GenericSchema<unknown, GrantRequester> = v.strictObject({
  kind: v.picklist(["human", "agent"]),
  id: v.pipe(v.string(), v.minLength(1)),
  runId: v.optional(v.pipe(v.string(), v.minLength(1))),
});

/** What the route parses. */
const GrantsBodySchema = v.strictObject({
  request: v.unknown(),
  snapshot: v.unknown(),
  manifests: v.optional(
    v.array(v.custom<ToolManifest>((value) => v.safeParse(ToolManifestSchema, value).success)),
    [],
  ),
  requestedBy: RequesterSchema,
  revokeRun: v.optional(v.pipe(v.string(), v.minLength(1))),
});

/** What the route answers with. */
interface GrantsAnswer {
  readonly ok: boolean;
  readonly grant?: SignedGrant;
  readonly code?: string;
  readonly message?: string;
  readonly policyRevision?: number | undefined;
  readonly policyHash?: string | undefined;
  readonly revoked?: readonly string[];
  /** Present with `tool_version`: the version the object's tool contracts declare. */
  readonly toolVersion?: string | undefined;
}

/** The failure code this route answers with; a subset of the Session RPC's closed vocabulary. */
type GrantFailureCode =
  | "method_not_allowed"
  | "unavailable"
  | "invalid_request"
  | "payload_too_large"
  | "unsupported_media_type"
  | "internal";

/** The failure status the Session RPC's table gives a code. */
const FAILURE_STATUS: Readonly<Record<GrantFailureCode, number>> = {
  method_not_allowed: 405,
  unavailable: 503,
  invalid_request: 400,
  payload_too_large: 413,
  unsupported_media_type: 415,
  internal: 500,
};

/** One typed failure. */
function failure(code: GrantFailureCode, message: string): Response {
  return json({ ok: false, code, message }, FAILURE_STATUS[code]);
}

/** The status for a denial: a policy refusal is a 403 the agent reads, never a 500. */
function refusalStatus(issue: GrantIssue): number {
  if (issue.ok) return 200;
  switch (issue.decision.code) {
    case "grant_invalid":
    case "manifest_mismatch":
    case "grant_algorithm_mismatch":
    case "unsupported":
      return 400;
    case "tool_disabled":
      return 403;
    default:
      return 400;
  }
}

/**
 * Handle `POST /rpc/grants`.
 *
 * @param request - The internal request.
 * @param grants - The session's grant plane; `undefined` when the object did not open one (it
 * answers `unavailable`, never an empty success).
 * @param limits - The body bound.
 * @returns The grant, the denial, or a typed failure.
 */
export async function handleGrantsRpc(
  request: Request,
  grants: GrantPlane | undefined,
  limits: { readonly maxBodyBytes: number },
): Promise<Response> {
  if (request.method !== "POST") return failure("method_not_allowed", "Only POST is allowed here.");
  if (grants === undefined) return failure("unavailable", "The grant surface is not open.");
  const body = await readBody(request, limits.maxBodyBytes);
  if (!body.ok) return failure(body.code, "The request body is not acceptable.");
  let raw: unknown;
  try {
    raw = JSON.parse(body.text);
  } catch {
    return failure("invalid_request", "The request body is not JSON.");
  }
  const parsed = v.safeParse(GrantsBodySchema, raw);
  if (!parsed.success) return failure("invalid_request", "Invalid grant input.");
  if (parsed.output.revokeRun !== undefined) {
    const revoked = await grants.revokeRun(parsed.output.revokeRun);
    return json({ ok: true, revoked });
  }
  const issue = await grants.request({
    request: parsed.output.request,
    snapshot: parsed.output.snapshot,
    requestedBy: parsed.output.requestedBy,
    manifests: parsed.output.manifests,
  });
  if (issue.ok)
    return json({ ok: true, grant: issue.grant, policyRevision: issue.grant.payload.epoch });
  return json(
    issue.toolVersion === undefined
      ? {
          ok: false,
          code: issue.decision.code,
          message: issue.decision.message,
          policyRevision: issue.decision.policyRevision,
          policyHash: issue.decision.policyHash,
        }
      : {
          ok: false,
          code: "tool_version",
          message: issue.decision.message,
          toolVersion: issue.toolVersion,
          policyRevision: issue.decision.policyRevision,
          policyHash: issue.decision.policyHash,
        },
    refusalStatus(issue),
  );
}

/**
 * A JSON answer whose headers forbid storing or logging it.
 *
 * @param body - The object to write.
 * @param status - The status.
 * @returns The response.
 */
function json(body: GrantsAnswer, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
