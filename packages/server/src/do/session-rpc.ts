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
import { ModelUnavailableError } from "./models.ts";

/** The closed failure codes of the internal Session RPC. */
type SessionRpcCode = FailureCodeOf<"session-rpc">;

/** The injections the Session's transport gives the RPC; production passes its cost gate. */
export interface SessionRpcDependencies {
  /** The monthly cost gate; absent when the deployment binds no control database. */
  readonly cost?: CostGate | undefined;
  /**
   * The request id the turn actually used (body first, then the forwarded header).
   *
   * @remarks
   * The Session uses it to match the agent event it just recorded, so a successful turn does
   * not write a second `do.rpc` row. Called before the send; a refused turn still gets no skip.
   */
  readonly onRequestId?: ((requestId: string | undefined) => void) | undefined;
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

const SendSchema = v.object({
  text: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_INPUT_LENGTH)),
  requestId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
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
  if (segments[0] !== "rpc" || segments[1] !== "conversations") {
    return failure("not_found", "No Session RPC route matches this path.");
  }
  const id = segments[2];
  const tail = segments[3];
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
