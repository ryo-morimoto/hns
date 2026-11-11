import { readBody } from "./body.ts";
import { REQUEST_ID_HEADER, resolveRequestId, withResponseRequestId } from "./correlation.ts";
import type { WorkerEnv } from "./env.ts";
import { DEFAULT_LIMITS, type EdgeLimits } from "./limits.ts";
import { problem } from "./problem.ts";
import { readSessionCookie, type Session } from "./session.ts";

/** What every face receives after authentication. */
export interface EdgeRequest {
  readonly request: Request;
  readonly env: WorkerEnv;
  readonly session: Session;
  readonly requestId: string;
  /** Aborted when the request deadline expires. */
  readonly signal: AbortSignal;
}

/** The GraphQL face additionally receives the body it may parse. */
export interface GraphQLRequest extends EdgeRequest {
  readonly body: string;
}

/** The handlers owned by the issues that implement each face. */
export interface HandlerDependencies {
  readonly graphql: (request: GraphQLRequest) => Promise<Response>;
  readonly ws: (request: EdgeRequest) => Promise<Response>;
}

/** The fetch signature the Worker module exposes. */
export type EdgeFetch = (request: Request, env: WorkerEnv) => Promise<Response>;

class DeadlineError extends Error {
  constructor() {
    super("request deadline exceeded");
    this.name = "DeadlineError";
  }
}

/**
 * Run `work` with a wall-clock deadline.
 *
 * @internal
 * @throws DeadlineError when the deadline wins; the work keeps running until its own
 * signal-aware call observes the abort.
 */
async function withDeadline(
  work: Promise<Response>,
  ms: number,
  controller: AbortController,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DeadlineError());
    }, ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Check the `hns_session` cookie.
 *
 * @internal
 * @returns The session, or null when the cookie is missing or invalid. A missing or short
 * secret is a denial, not an error.
 */
async function authenticate(request: Request, env: WorkerEnv): Promise<Session | null> {
  return readSessionCookie(request.headers.get("cookie"), env.HNS_SESSION_SECRET);
}

/**
 * Build a 405 response with the allowed method.
 *
 * @internal
 */
function methodNotAllowed(allowed: "GET" | "POST", path: string): Response {
  const response = problem(
    "method_not_allowed",
    "Only " + allowed + " is allowed on this path.",
    path,
  );
  response.headers.set("allow", allowed);
  return response;
}

/**
 * Route one request after the correlation id is known.
 *
 * @internal
 */
async function route(
  request: Request,
  env: WorkerEnv,
  path: string,
  requestId: string,
  signal: AbortSignal,
  dependencies: HandlerDependencies,
  limits: EdgeLimits,
): Promise<Response> {
  if (path === "/graphql") {
    if (request.method !== "POST") return methodNotAllowed("POST", path);
    const session = await authenticate(request, env);
    if (session === null) {
      return problem("unauthorized", "A valid session cookie is required.", path);
    }
    const body = await readBody(request, limits.maxBodyBytes);
    if (!body.ok) {
      const detail =
        body.code === "payload_too_large"
          ? "The request body exceeds the configured limit."
          : "The request body must be application/json.";
      return problem(body.code, detail, path);
    }
    return dependencies.graphql({ request, env, session, requestId, signal, body: body.text });
  }
  if (path === "/ws") {
    if (request.method !== "GET") return methodNotAllowed("GET", path);
    const session = await authenticate(request, env);
    if (session === null) {
      return problem("unauthorized", "A valid session cookie is required.", path);
    }
    return dependencies.ws({ request, env, session, requestId, signal });
  }
  if (path === "/api" || path.startsWith("/api/")) {
    return problem("not_found", "No route matches this path.", path);
  }
  if (request.method === "GET" || request.method === "HEAD") {
    if (env.ASSETS === undefined) {
      return problem("not_found", "Static assets are not configured.", path);
    }
    return env.ASSETS.fetch(new Request(request, { signal }));
  }
  return problem("not_found", "No route matches this path.", path);
}

/**
 * Build the Worker fetch handler.
 *
 * @param dependencies - The GraphQL and WebSocket handlers; the edge owns routing, auth,
 * correlation, and limits around them.
 * @param limits - Per-request budgets; tests pass smaller values.
 * @returns A fetch function with the Worker signature.
 *
 * @remarks
 * The correlation id is resolved first, so every response (including 401 and 404) carries
 * one. Authentication happens before the body is read, so an unauthenticated oversized
 * request is denied without consuming it. The deadline covers authentication, body reading,
 * and the handler.
 */
export function createEdge(
  dependencies: HandlerDependencies,
  limits: EdgeLimits = DEFAULT_LIMITS,
): EdgeFetch {
  return async function edge(request: Request, env: WorkerEnv): Promise<Response> {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const path = new URL(request.url).pathname;
    const controller = new AbortController();
    let response: Response;
    try {
      response = await withDeadline(
        route(request, env, path, requestId, controller.signal, dependencies, limits),
        limits.maxRequestMs,
        controller,
      );
    } catch (error) {
      if (error instanceof DeadlineError) {
        response = problem("timeout", "The request exceeded the configured deadline.", path);
      } else {
        console.error(
          "edge: unhandled request",
          requestId,
          error instanceof Error ? error.name : "unknown",
        );
        response = problem("internal", "Unexpected failure.", path);
      }
    }
    return withResponseRequestId(response, requestId);
  };
}
