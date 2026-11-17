import { createGraphQLFace } from "../graphql/index.ts";
import { SESSION_NAME } from "../session-name.ts";
import { httpEntry } from "../obs/log.ts";
import { withRequestIdHeader } from "./correlation.ts";
import {
  createEdge,
  type EdgeRequest,
  type EdgeResponseEvent,
  type HandlerDependencies,
} from "./handler.ts";
import type { WorkerEnv } from "./env.ts";
import { problem } from "./problem.ts";

/** The internal path each REST face forwards to. */
function rpcPath(path: string): string | undefined {
  if (path === "/api/events") return "/rpc/events";
  if (path === "/api/metrics") return "/rpc/metrics";
  return undefined;
}

/** Address the one Session object this deployment names. */
function sessionStub(env: WorkerEnv) {
  const session = env.SESSION;
  if (session === undefined) return undefined;
  return session.get(session.idFromName(SESSION_NAME));
}

/**
 * Forward `/ws` to the Session Durable Object.
 *
 * @internal
 * @remarks
 * The edge owns authentication and the correlation id; the object owns the WebSocket and
 * the messages. A missing binding is a 503, not a 404: the face exists but is not wired.
 */
async function forwardToSession(request: EdgeRequest): Promise<Response> {
  const stub = sessionStub(request.env);
  const path = new URL(request.request.url).pathname;
  if (stub === undefined) {
    return problem("unavailable", "The session binding is not configured.", path);
  }
  const forwarded = new Request(request.request, {
    headers: withRequestIdHeader(request.request.headers, request.requestId),
    signal: request.signal,
  });
  return stub.fetch(forwarded);
}

/**
 * Forward the observability API to the Session Durable Object.
 *
 * @internal
 * @remarks
 * Authentication happened at the edge. The RPC path replaces the public path so the object
 * only exposes its internal surface; the correlation id and the query string travel unchanged.
 */
async function forwardObs(request: EdgeRequest): Promise<Response> {
  const stub = sessionStub(request.env);
  const url = new URL(request.request.url);
  const path = rpcPath(url.pathname);
  if (path === undefined) return problem("not_found", "No route matches this path.", url.pathname);
  if (stub === undefined) {
    return problem("unavailable", "The session binding is not configured.", url.pathname);
  }
  const forwarded = new Request("https://session.internal" + path + url.search, {
    method: "GET",
    headers: withRequestIdHeader(request.request.headers, request.requestId),
    signal: request.signal,
  });
  return stub.fetch(forwarded);
}

/**
 * Record one finished request in the Session object.
 *
 * @internal
 * @remarks
 * Fire and forget: the request has already been served, and a failed write must not change the
 * answer. The entry carries the pathname and status only, never a body or a header value.
 */
function recordResponse(event: EdgeResponseEvent, env: WorkerEnv): void {
  const stub = sessionStub(env);
  if (stub === undefined) return;
  const entry = httpEntry({ ...event, now: Date.now() });
  const forwarded = new Request("https://session.internal/rpc/events", {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": event.requestId },
    body: JSON.stringify(entry),
  });
  void stub.fetch(forwarded).catch((error) => {
    console.error(
      "edge: event write failed",
      event.requestId,
      error instanceof Error ? error.name : "unknown",
    );
  });
}

const dependencies: HandlerDependencies = {
  graphql: createGraphQLFace(),
  ws: forwardToSession,
  obs: forwardObs,
  onResponse: recordResponse,
};

const edge = createEdge(dependencies);

export default { fetch: edge };
