import * as v from "valibot";
import {
  ConversationNotFoundError,
  InvalidConversationIdError,
  MAX_CONVERSATION_PAGE,
  MAX_INPUT_LENGTH,
  MAX_TRANSCRIPT_PAGE,
  type AgentSession,
} from "@hns/agent/session";
import {
  CostGaugeUnavailableError,
  CostLimitError,
  type CostBudget,
  type CostGate,
} from "../cost/index.ts";
import { readBody } from "../edge/body.ts";
import { REQUEST_ID_HEADER } from "../edge/correlation.ts";
import { DEFAULT_LIMITS } from "../edge/limits.ts";
import { failureStatus, type FailureCodeOf } from "../failures/status.ts";
import { AUDIT_MAX_LIMIT, denialOf, type AuditRow, type PolicyAudit } from "./audit.ts";
import type { JsonValue } from "@hns/core";
import { TOOL_RUN_ROUTE, TOOL_RUN_TOKEN_HEADER } from "@hns/workspace/protocol";
import type { GrantedAnswer } from "@hns/workspace/protocol";
import type { GrantPlane } from "./session-grants.ts";
import {
  GrantedCallRequestSchema,
  failure as toolFailure,
  json as toolJson,
  type ToolPath,
} from "./session-tools.ts";
import { handleGrantsRpc } from "./session-grants-rpc.ts";
import { ModelUnavailableError } from "./models.ts";

/** The closed failure codes of the internal Session RPC. */
type SessionRpcCode = FailureCodeOf<"session-rpc">;

/** The injections the Session's transport gives the RPC; production passes its cost gate. */
export interface SessionRpcDependencies {
  /** The monthly cost gate; absent when the deployment binds no control database. */
  readonly cost?: CostGate | undefined;
  /**
   * The object's policy audit, for `GET /rpc/policy/audit`.
   *
   * @remarks
   * The Session owns the table; this face reads it, which is why the audit is a dependency here rather
   * than a member of `AgentSession`: the agent's public API does not grow for an internal reader
   * (`docs/capability.md` §8, §10). Absent means the route answers `unavailable` rather than an
   * empty list a caller could mistake for "no decisions were made".
   */
  readonly audit?: PolicyAudit | undefined;
  /**
   * The request id the turn actually used (body first, then the forwarded header).
   *
   * @remarks
   * The Session uses it to match the agent event it just recorded, so a successful turn does
   * not write a second `do.rpc` row. Called before the send; a refused turn still gets no skip.
   */
  readonly onRequestId?: ((requestId: string | undefined) => void) | undefined;
  /**
   * The object's grant plane, for `POST /rpc/grants` (0224).
   *
   * @remarks
   * Absent means the route answers `unavailable` rather than an empty success: a caller must not read
   * "no grant" as "you hold no capability". The edge never forwards this route; only the Worker's own
   * `requestGrant` mutation does, after it verified the person and the machine.
   */
  readonly grants?: GrantPlane | undefined;
  /**
   * The token the Worker must present on `POST /rpc/grants`, derived from the session secret.
   *
   * @remarks
   * Absent (or undefined) means the object cannot tell the Worker from any other caller, and the
   * grant route refuses every request (fail closed, NB7).
   */
  readonly grantToken?: string | undefined;
  /** The edge's per-request budgets, for the grant body. */
  readonly limits?: { readonly maxBodyBytes: number } | undefined;
  /**
   * The object's granted tool path: the policy snapshot a send is admitted under, the runs' tokens,
   * and the relay a run's granted call goes through.
   *
   * @remarks
   * Absent means the granted path is off: the relay route answers `unavailable` rather than run a
   * call nobody decided, and the object has no revision to issue a grant under. Present, a send
   * **with** a snapshot is admitted under it (a missing or older revision is refused, see
   * `admitTurn`); a send **without** one is answered as usual and admits nothing new.
   */
  readonly tools?: ToolPath | undefined;
}

/**
 * The message a refused run carries.
 *
 * @internal
 */
function refusalMessage(budget: CostBudget): string {
  switch (budget) {
    case "doRows":
      return "The monthly DO row limit is used up.";
    case "doRequests":
      return "The monthly DO request limit is used up.";
    case "r2Objects":
      return "The monthly R2 object limit is used up.";
    case "provider":
      return "The monthly provider budget is used up.";
    default: {
      const unhandled: never = budget;
      throw new Error("unknown cost budget: " + String(unhandled));
    }
  }
}

interface SessionRpcFailure {
  readonly ok: false;
  readonly code: SessionRpcCode;
  readonly message: string;
}

// The title rules live in openSession's schema; this boundary only enforces the JSON shape.
const CreateSchema = v.object({
  title: v.string(),
  projectId: v.optional(v.pipe(v.string(), v.minLength(1)), "default"),
  /**
   * The project's workspace root, resolved by the caller from D1.
   *
   * @remarks
   * Optional because the internal face has callers older than project roots; omitted means the
   * root is unknown, and the conversation gets no agent cwd rather than a guessed one.
   */
  workspaceRoot: v.optional(v.string()),
});

/** A JSON value, for a body's member that is parsed by its own contract later. */
const JsonValueSchema: v.GenericSchema<unknown, JsonValue> = v.lazy(() =>
  v.union([
    v.null(),
    v.boolean(),
    v.number(),
    v.string(),
    v.array(JsonValueSchema),
    v.record(v.string(), JsonValueSchema),
  ]),
);

/** A JSON object, for a body's member that is parsed as one later. */
const JsonObjectSchema: v.GenericSchema<unknown, Readonly<Record<string, JsonValue>>> = v.record(
  v.string(),
  v.union([
    v.null(),
    v.boolean(),
    v.number(),
    v.string(),
    v.array(v.any()),
    v.record(v.string(), v.any()),
  ]),
);

const SendSchema = v.object({
  text: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_INPUT_LENGTH)),
  requestId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
  /**
   * The workspace's active policy revision, as the Worker read it for this turn.
   *
   * @remarks
   * The Session object never reads D1 (D049), so the Worker sends the revision it read. It is
   * parsed and hash-checked here (`admitTurn`), and the object **does not pass it to the agent**:
   * the model must not learn the policy. A turn on the granted path needs it; a turn whose policy
   * the Worker could not read is refused rather than run under a stale one.
   */
  policy: v.optional(JsonValueSchema),
});

const LimitValue = v.pipe(
  v.string(),
  v.regex(/^[1-9][0-9]*$/u),
  v.transform((value) => Number(value)),
  v.integer(),
  v.minValue(1),
);

/**
 * Parse a page size from the query string.
 *
 * @internal
 * @returns The page size, undefined when absent, or the 400 to send.
 */
function limitOf(
  url: URL,
  maximum: number,
):
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly response: Response } {
  const raw = url.searchParams.get("limit");
  if (raw === null) return { ok: true, value: undefined };
  const parsed = v.safeParse(LimitValue, raw);
  if (!parsed.success || parsed.output > maximum) {
    return {
      ok: false,
      response: failure(
        "invalid_request",
        "limit must be an integer between 1 and " + String(maximum) + ".",
      ),
    };
  }
  return { ok: true, value: parsed.output };
}

/** A JSON response with no caching. */
function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * A typed failure.
 *
 * @remarks
 * The status comes from the server's one table (`failures/status.ts`); the caller names the code
 * and nothing else.
 */
function failure(code: SessionRpcCode, message: string): Response {
  const body: SessionRpcFailure = { ok: false, code, message };
  return json(body, failureStatus("session-rpc", code));
}

/** Read and parse a JSON body, or return the failure to send. */
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

/** Map an expected session failure to the RPC envelope. */
function failureOf(error: Error): Response | undefined {
  if (error instanceof InvalidConversationIdError) {
    return failure("invalid_request", error.message);
  }
  if (error instanceof ConversationNotFoundError) {
    return failure("not_found", error.message);
  }
  if (error instanceof ModelUnavailableError) {
    return failure("unavailable", error.message);
  }
  if (error instanceof v.ValiError) {
    return failure("invalid_request", "The request did not match the session contract.");
  }
  return undefined;
}

/** The default rows one audit read returns. */
const AUDIT_DEFAULT_LIMIT = 50;

/** One audit row as the RPC answers it: the chain's members, in the contract's spelling. */
interface AuditRowJson {
  readonly seq: number;
  readonly eventId: string;
  readonly at: string;
  readonly event: "tool.call" | "tool.result";
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly callId: string;
  readonly callHash?: string | undefined;
  readonly argsHash?: string | undefined;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly manifestHash: string;
  readonly decision?: unknown;
  readonly durationMs?: number | undefined;
  readonly grantId?: string | undefined;
  readonly prevHash: string | null;
  readonly hash: string;
  /** A refusal's code, for a reader that wants only that. */
  readonly denial?: string | undefined;
}

/**
 * One stored row as the answer's JSON.
 *
 * @remarks
 * The row is the contract's event plus `seq`. A refused call's hashes are left **out** (`callHash`
 * and `argsHash` are absent, not `null` and not `""`, `AuditEventBase`); a `tool.call` has no
 * decision and no duration. No argument, output, or secret is in the row to begin with.
 */
function auditRowJson(row: AuditRow): AuditRowJson {
  const denial = denialOf(row);
  const hashes =
    row.callHash === null || row.argsHash === null
      ? {}
      : { callHash: row.callHash, argsHash: row.argsHash };
  const decision =
    row.decision === null ? {} : { decision: row.decision, durationMs: row.durationMs ?? 0 };
  const grant = row.grantId === null ? {} : { grantId: row.grantId };
  const refusal = denial === undefined ? {} : { denial };
  return {
    seq: row.seq,
    eventId: row.eventId,
    at: row.at,
    event: row.event,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    callId: row.callId,
    ...hashes,
    toolId: row.toolId,
    toolVersion: row.toolVersion,
    manifestHash: row.manifestHash,
    ...decision,
    ...grant,
    prevHash: row.prevHash,
    hash: row.hash,
    ...refusal,
  };
}

/**
 * `GET /rpc/policy/audit?limit=`: the newest rows of the object's audit, oldest first.
 *
 * @param request - The internal request.
 * @param audit - The object's audit, or undefined when it is not open.
 * @returns `{ok:true, rows}` ascending by `seq`, or the typed failure.
 *
 * @remarks
 * `limit` is 1..{@link AUDIT_MAX_LIMIT}, 50 when absent; anything else is `invalid_request`.
 * Reading does not verify the chain: the page is what an operator reads, and the chain is checked by
 * re-walking the table (0222's verifier).
 */
async function handleAuditRpc(
  request: Request,
  url: URL,
  audit: PolicyAudit | undefined,
): Promise<Response> {
  if (request.method !== "GET") {
    return failure("method_not_allowed", "Only GET is allowed here.");
  }
  if (audit === undefined) {
    return failure("unavailable", "The policy audit is not open.");
  }
  const limit = limitOf(url, AUDIT_MAX_LIMIT);
  if (!limit.ok) return limit.response;
  const rows = await audit.list(limit.value ?? AUDIT_DEFAULT_LIMIT);
  const body = { ok: true, rows: rows.map(auditRowJson) };
  return json(body);
}

/**
 * The send body's snapshot, as the state's parser takes it.
 *
 * @param policy - The body's `policy`, which is untrusted JSON.
 * @returns The object, or an empty one for a value that is not: the state's parser refuses it, and
 * the send fails.
 */
function asPolicySnapshotPayload(policy: JsonValue): Readonly<Record<string, JsonValue>> {
  const parsed = v.safeParse(JsonObjectSchema, policy);
  return parsed.success ? parsed.output : {};
}

/**
 * Serve one run's granted call: `POST /rpc/conversations/<runId>/tool`.
 *
 * @param request - The agent's relay request.
 * @param runId - The conversation whose run asks; the route's id is the run the token is checked for.
 * @param tools - The object's granted path; undefined answers `unavailable` (fail closed).
 * @returns The machine's answer, or the typed failure.
 *
 * @remarks
 * The agent proves it is this run's agent with the token the object minted for it: a missing token,
 * another run's token, an expired one, or a token for a conversation that has none is
 * `forbidden_internal` (401), and nothing is issued or relayed. The body names the call and the
 * manifest; a body that is not one is `invalid_request` before anything looks up a policy.
 *
 * The answer is the machine's own: an allow with the operation's result, or the denial. A failure of
 * the relay is `unavailable`, never an allow.
 */
async function handleToolRelay(
  request: Request,
  runId: string | undefined,
  tools: ToolPath | undefined,
): Promise<Response> {
  if (request.method !== "POST") {
    return failure("method_not_allowed", "Only POST is allowed here.");
  }
  if (tools === undefined) {
    return toolFailure("unavailable", "The granted tool path is not open.");
  }
  if (runId === undefined) {
    return failure("not_found", "No conversation is named.");
  }
  if (!tools.state.check(runId, request.headers.get(TOOL_RUN_TOKEN_HEADER))) {
    // The run's own agent holds the token; nothing else relays as that run.
    return failure("forbidden_internal", "This run has no relay token, or it is not valid.");
  }
  const body = await bodyOf(request);
  if (!body.ok) return body.response;
  const parsed = v.safeParse(GrantedCallRequestSchema, body.value);
  if (!parsed.success) {
    return failure("invalid_request", "Invalid granted call input.");
  }
  const outcome = await tools.relay(runId, parsed.output);
  if (!outcome.ok) return toolFailure(outcome.code, outcome.message);
  return toolJson(grantedAnswerJson(outcome.answer));
}

/**
 * The machine's answer as the agent's JSON.
 *
 * @param answer - The decision, and for an allow the grant id and the operation's result.
 * @returns The answer on the wire, member by member: the decision is the contract's own fields, and
 * the result is the operation's JSON.
 */
function grantedAnswerJson(answer: GrantedAnswer): JsonValue {
  switch (answer.decision.outcome) {
    case "deny": {
      const decision = answer.decision;
      const denial: JsonValue = {
        outcome: "deny",
        code: decision.code,
        message: decision.message,
      };
      if (decision.policyRevision !== undefined) {
        denial["policyRevision"] = decision.policyRevision;
      }
      if (decision.policyHash !== undefined) denial["policyHash"] = decision.policyHash;
      return { decision: denial };
    }
    case "allow": {
      const decision = answer.decision;
      const allow: JsonValue = {
        outcome: "allow",
        policyRevision: decision.policyRevision,
        policyHash: decision.policyHash,
      };
      if (decision.grantId !== undefined) allow["grantId"] = decision.grantId;
      return {
        decision: allow,
        grantId: answer.grantId ?? "",
        // SAFETY: the machine's operation result is JSON by its wire contract (the machine writes a
        // JSON body); the relay parsed the answer as one before this.
        result: answer.result as JsonValue,
      };
    }
  }
}

/**
 * Handle one internal Session RPC request.
 *
 * @param request - A request forwarded by the Worker through the `SESSION` binding.
 * @param session - The open Session runtime.
 * @param dependencies - The monthly cost gate, if the deployment has a control database.
 * @returns A JSON response; expected failures carry `{ok:false, code}`.
 *
 * @remarks
 * These routes are not public Worker routes. The edge only forwards `/ws`, and the GraphQL
 * resolver will call this module through the binding. Bodies are parsed here even though the
 * caller is trusted, so an internal mistake fails as a 400 instead of corrupting the Session.
 * A new run is admitted against the monthly cost gate before `session.send`; a refused run is
 * a 429 with a closed code and leaves every existing run alone.
 */
export async function handleSessionRpc(
  request: Request,
  session: AgentSession,
  dependencies: SessionRpcDependencies = {},
): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments[0] === "rpc" && segments[1] === "policy" && segments[2] === "audit") {
    try {
      return await handleAuditRpc(request, url, dependencies.audit);
    } catch (error) {
      if (error instanceof Error) console.error("session rpc failed", error.name);
      return failure("internal", "Unexpected Session failure.");
    }
  }
  if (segments[0] === "rpc" && segments[1] === "grants" && segments.length === 2) {
    try {
      return await handleGrantsRpc(request, dependencies.grants, {
        ...(dependencies.limits ?? DEFAULT_LIMITS),
        token: dependencies.grantToken,
      });
    } catch (error) {
      if (error instanceof Error) console.error("session rpc failed", error.name);
      return failure("internal", "Unexpected Session failure.");
    }
  }
  if (segments[0] !== "rpc" || segments[1] !== "conversations") {
    return failure("not_found", "No Session RPC route matches this path.");
  }
  const id = segments[2];
  const tail = segments[3];
  // The route's own name, without the leading separator the constant is exported with.
  const toolTail = TOOL_RUN_ROUTE.replace(/^\//u, "");
  if (segments.length === 4 && tail === toolTail) {
    try {
      return await handleToolRelay(request, id, dependencies.tools);
    } catch (error) {
      if (error instanceof Error) console.error("session rpc failed", error.name);
      return failure("internal", "Unexpected Session failure.");
    }
  }
  try {
    if (id === undefined) {
      if (request.method === "POST") {
        const body = await bodyOf(request);
        if (!body.ok) return body.response;
        const parsed = v.safeParse(CreateSchema, body.value);
        if (!parsed.success) return failure("invalid_request", "Invalid conversation input.");
        const base = { title: parsed.output.title };
        const withProject =
          parsed.output.projectId === undefined
            ? base
            : { ...base, projectId: parsed.output.projectId };
        const input =
          parsed.output.workspaceRoot === undefined
            ? withProject
            : { ...withProject, workspaceRoot: parsed.output.workspaceRoot };
        const conversation = await session.createConversation(input);
        return json({ ok: true, conversation }, 201);
      }
      if (request.method === "GET") {
        const limit = limitOf(url, MAX_CONVERSATION_PAGE);
        if (!limit.ok) return limit.response;
        const conversations = await session.listConversations(limit.value);
        return json({ ok: true, conversations });
      }
      return failure("method_not_allowed", "Only GET and POST are allowed here.");
    }
    if (tail === undefined) {
      if (request.method !== "GET") {
        return failure("method_not_allowed", "Only GET is allowed here.");
      }
      const conversation = await session.getConversation(id);
      if (conversation === undefined) {
        return failure("not_found", "No conversation has this id.");
      }
      return json({ ok: true, conversation });
    }
    if (tail === "transcript") {
      if (request.method !== "GET") {
        return failure("method_not_allowed", "Only GET is allowed here.");
      }
      const limit = limitOf(url, MAX_TRANSCRIPT_PAGE);
      if (!limit.ok) return limit.response;
      const entries = await session.transcript(id, limit.value);
      return json({ ok: true, entries });
    }
    if (tail === "messages") {
      if (request.method !== "POST") {
        return failure("method_not_allowed", "Only POST is allowed here.");
      }
      const body = await bodyOf(request);
      if (!body.ok) return body.response;
      const parsed = v.safeParse(SendSchema, body.value);
      if (!parsed.success) return failure("invalid_request", "Invalid message input.");
      const tools = dependencies.tools;
      if (tools !== undefined && parsed.output.policy !== undefined) {
        // The granted path: the turn is admitted under the policy the Worker read, and the object
        // refuses one older than a revision it already admitted.
        const admitted = await tools.state.admitTurn(asPolicySnapshotPayload(parsed.output.policy));
        if (!admitted.ok) {
          // A snapshot that is not one is the request's fault; one older than what this object
          // already admitted is a policy that moved, which is `unavailable` to this turn.
          return failure(
            admitted.code === "epoch_stale" ? "unavailable" : "invalid_request",
            admitted.message,
          );
        }
      }
      // A send with **no** snapshot is answered as usual (200) and the object keeps the last
      // admitted revision: the turn is not refused. What it does not do is admit a *new* revision,
      // and a run whose send carried no snapshot has no grant path of its own until one does. The
      // route is therefore never 400 for a missing snapshot — that would stop every conversation.
      const cost = dependencies.cost;
      if (cost !== undefined) {
        try {
          await cost.admit(new Date());
        } catch (error) {
          if (error instanceof CostLimitError) {
            return failure("limit_exceeded", refusalMessage(error.budget));
          }
          if (error instanceof CostGaugeUnavailableError) {
            return failure("limit_unavailable", "The monthly cost limits could not be read.");
          }
          throw error;
        }
      }
      // The edge forwards x-request-id on every RPC; a body id still wins for an internal caller.
      const headerId = request.headers.get(REQUEST_ID_HEADER);
      const requestId = parsed.output.requestId ?? headerId ?? undefined;
      dependencies.onRequestId?.(requestId);
      const run = (): ReturnType<AgentSession["send"]> =>
        session.send(id, parsed.output.text, requestId);
      const turn =
        cost === undefined
          ? await run()
          : await cost.turn(
              {
                id: requestId ?? crypto.randomUUID(),
                conversationId: id,
                requests: 1,
              },
              run,
            );
      // The turn actually began: the revocation that ended the previous turn no longer refuses this
      // one (the run is granted afresh, with its own grant). A send that failed above leaves the
      // mark alone, so an aborted turn's grant is never revived by a failure.
      if (tools !== undefined) tools.state.beginTurn(id);
      return json({
        ok: true,
        submissionId: String(turn.settlement.id),
        status: turn.settlement.status,
        text: turn.text,
      });
    }
    if (tail === "abort") {
      if (request.method !== "POST") {
        return failure("method_not_allowed", "Only POST is allowed here.");
      }
      const aborted = await session.abort(id);
      if (!aborted) return failure("not_found", "No conversation has this id.");
      return json({ ok: true });
    }
    return failure("not_found", "No Session RPC route matches this path.");
  } catch (error) {
    if (error instanceof Error) {
      const expected = failureOf(error);
      if (expected !== undefined) return expected;
      console.error("session rpc failed", error.name);
    }
    return failure("internal", "Unexpected Session failure.");
  }
}
