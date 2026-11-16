import { createGraphQLFace } from "../graphql/index.ts";
import { SESSION_NAME } from "../session-name.ts";
import { withRequestIdHeader } from "./correlation.ts";
import { createEdge, type EdgeRequest, type HandlerDependencies } from "./handler.ts";
import { problem } from "./problem.ts";

/**
 * Forward `/ws` to the Session Durable Object.
 *
 * @internal
 * @remarks
 * The edge owns authentication and the correlation id; the object owns the WebSocket and
 * the messages. A missing binding is a 503, not a 404: the face exists but is not wired.
 */
async function forwardToSession(request: EdgeRequest): Promise<Response> {
  const session = request.env.SESSION;
  const path = new URL(request.request.url).pathname;
  if (session === undefined) {
    return problem("unavailable", "The session binding is not configured.", path);
  }
  const forwarded = new Request(request.request, {
    headers: withRequestIdHeader(request.request.headers, request.requestId),
    signal: request.signal,
  });
  return session.get(session.idFromName(SESSION_NAME)).fetch(forwarded);
}

const dependencies: HandlerDependencies = {
  graphql: createGraphQLFace(),
  ws: forwardToSession,
};

const edge = createEdge(dependencies);

export default { fetch: edge };
