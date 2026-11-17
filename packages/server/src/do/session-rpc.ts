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
import { ModelUnavailableError } from "./models.ts";

/** The closed failure codes of the internal Session RPC. */
type SessionRpcCode =
  | "invalid_request"
  | "not_found"
  | "unavailable"
  | "limit_exceeded"
  | "limit_unavailable"
  | "internal";

/** The injections the Session's transport gives the RPC; production passes its cost gate. */
export interface SessionRpcDependencies {
  /** The monthly cost gate; absent when the deployment binds no control database. */
  readonly cost?: CostGate | undefined;
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
        400,
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

/** A typed failure. */
function failure(code: SessionRpcCode, message: string, status: number): Response {
  const body: SessionRpcFailure = { ok: false, code, message };
  return json(body, status);
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

/** Map an expected session failure to the RPC envelope. */
function failureOf(error: Error): Response | undefined {
  if (error instanceof InvalidConversationIdError) {
    return failure("invalid_request", error.message, 400);
  }
  if (error instanceof ConversationNotFoundError) {
    return failure("not_found", error.message, 404);
  }
  if (error instanceof ModelUnavailableError) {
    return failure("unavailable", error.message, 503);
  }
  if (error instanceof v.ValiError) {
    return failure("invalid_request", "The request did not match the session contract.", 400);
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
    return failure("not_found", "No Session RPC route matches this path.", 404);
  }
  const id = segments[2];
  const tail = segments[3];
  try {
    if (id === undefined) {
      if (request.method === "POST") {
        const body = await bodyOf(request);
        if (!body.ok) return body.response;
        const parsed = v.safeParse(CreateSchema, body.value);
        if (!parsed.success) return failure("invalid_request", "Invalid conversation input.", 400);
        const input =
          parsed.output.projectId === undefined
            ? { title: parsed.output.title }
            : { title: parsed.output.title, projectId: parsed.output.projectId };
        const conversation = await session.createConversation(input);
        return json({ ok: true, conversation }, 201);
      }
      if (request.method === "GET") {
        const limit = limitOf(url, MAX_CONVERSATION_PAGE);
        if (!limit.ok) return limit.response;
        const conversations = await session.listConversations(limit.value);
        return json({ ok: true, conversations });
      }
      return failure("invalid_request", "Only GET and POST are allowed here.", 405);
    }
    if (tail === undefined) {
      if (request.method !== "GET") {
        return failure("invalid_request", "Only GET is allowed here.", 405);
      }
      const conversation = await session.getConversation(id);
      if (conversation === undefined) {
        return failure("not_found", "No conversation has this id.", 404);
      }
      return json({ ok: true, conversation });
    }
    if (tail === "transcript") {
      if (request.method !== "GET") {
        return failure("invalid_request", "Only GET is allowed here.", 405);
      }
      const limit = limitOf(url, MAX_TRANSCRIPT_PAGE);
      if (!limit.ok) return limit.response;
      const entries = await session.transcript(id, limit.value);
      return json({ ok: true, entries });
    }
    if (tail === "messages") {
      if (request.method !== "POST") {
        return failure("invalid_request", "Only POST is allowed here.", 405);
      }
      const body = await bodyOf(request);
      if (!body.ok) return body.response;
      const parsed = v.safeParse(SendSchema, body.value);
      if (!parsed.success) return failure("invalid_request", "Invalid message input.", 400);
      const cost = dependencies.cost;
      if (cost !== undefined) {
        try {
          await cost.admit(new Date());
        } catch (error) {
          if (error instanceof CostLimitError) {
            return failure("limit_exceeded", refusalMessage(error.budget), 429);
          }
          if (error instanceof CostGaugeUnavailableError) {
            return failure("limit_unavailable", "The monthly cost limits could not be read.", 503);
          }
          throw error;
        }
      }
      // The edge forwards x-request-id on every RPC; a body id still wins for an internal caller.
      const headerId = request.headers.get(REQUEST_ID_HEADER);
      const requestId = parsed.output.requestId ?? headerId ?? undefined;
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
        return failure("invalid_request", "Only POST is allowed here.", 405);
      }
      const aborted = await session.abort(id);
      if (!aborted) return failure("not_found", "No conversation has this id.", 404);
      return json({ ok: true });
    }
    return failure("not_found", "No Session RPC route matches this path.", 404);
  } catch (error) {
    if (error instanceof Error) {
      const expected = failureOf(error);
      if (expected !== undefined) return expected;
      console.error("session rpc failed", error.name);
    }
    return failure("internal", "Unexpected Session failure.", 500);
  }
}
