import { withRequestIdHeader } from "./correlation.ts";
import {
  createEdge,
  type EdgeRequest,
  type GraphQLRequest,
  type HandlerDependencies,
} from "./handler.ts";
import { problem } from "./problem.ts";

/**
 * The Durable Object name used until workspace selection exists.
 *
 * @remarks
 * One workspace means one Session (D049), but the edge does not yet know a workspace id.
 * The single default name is the placeholder; workspace selection replaces it when the
 * request carries a workspace.
 */
const SESSION_NAME = "default";

/**
 * The GraphQL face is reserved and closed until its handler lands.
 *
 * @internal
 */
async function graphqlNotImplemented(request: GraphQLRequest): Promise<Response> {
  return problem(
    "not_implemented",
    "The GraphQL face is not implemented yet.",
    new URL(request.request.url).pathname,
  );
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
  graphql: graphqlNotImplemented,
  ws: forwardToSession,
};

const edge = createEdge(dependencies);

export default { fetch: edge };
