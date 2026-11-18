import { ProjectIdSchema, type Project } from "@hns/core";
import * as v from "valibot";
import { createCheckpointFace } from "../checkpoint/face.ts";
import { createFilesFace } from "../files/content.ts";
import { createKeysFace } from "../machines/keys.ts";
import { createConversationsFace, lookupConversation } from "../conversations/index.ts";
import { createGraphQLFace } from "../graphql/index.ts";
import { httpEntry } from "../obs/log.ts";
import { ProjectParamSchema } from "../project-id.ts";
import { LEGACY_SESSION_NAME, sessionNameFor } from "../session-name.ts";
import { withRequestIdHeader } from "./correlation.ts";
import { projectFor, StoreUnavailableError } from "./store.ts";
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

/** Address the Session object with `name`. */
function sessionStub(env: WorkerEnv, name: string) {
  const session = env.SESSION;
  if (session === undefined) return undefined;
  return session.get(session.idFromName(name));
}

/** The one project the observability log belongs to (the legacy default object). */
const OBS_SESSION_NAME = LEGACY_SESSION_NAME;

/** Find one project in D1; a missing store or a failed read rejects. */
export type ProjectLookup = (env: WorkerEnv, projectId: string) => Promise<Project | undefined>;

/** The production lookup: the shared D1 project lookup. */
async function lookupProject(env: WorkerEnv, projectId: string): Promise<Project | undefined> {
  return await projectFor(env, v.parse(ProjectIdSchema, projectId));
}

/** Why a WebSocket request named no usable Session object. */
type SessionNameResult =
  | { readonly ok: true; readonly name: string }
  | {
      readonly ok: false;
      readonly code: "invalid_request" | "not_found" | "unavailable";
      readonly message: string;
    };

/**
 * Decide which Session object a `/ws` request addresses.
 *
 * @param env - The Worker environment (for the D1 lookup).
 * @param raw - The `project` query value, or null when the client named none.
 * @param lookup - The project lookup; production uses D1, tests inject a fake.
 * @returns The object name, or the typed refusal.
 *
 * @remarks
 * A missing `project` keeps the legacy default object, so a client that predates project
 * switching still reaches its conversations. An explicit project is verified in D1 **before**
 * `idFromName`, so an unknown or empty project never creates a Session object (D080). An
 * unreadable database is `unavailable`, not `not_found`; a corrupt row is not caught here, so
 * it reaches the edge as a defect (500) instead of a retryable outage.
 */
export async function resolveSessionName(
  env: WorkerEnv,
  raw: string | null,
  lookup: ProjectLookup = lookupProject,
): Promise<SessionNameResult> {
  if (raw === null) return { ok: true, name: LEGACY_SESSION_NAME };
  const parsed = v.safeParse(ProjectParamSchema, raw);
  if (!parsed.success) {
    return { ok: false, code: "invalid_request", message: "project is not a project id." };
  }
  let project: Project | undefined;
  try {
    project = await lookup(env, parsed.output);
  } catch (error) {
    if (!(error instanceof StoreUnavailableError)) throw error;
    return { ok: false, code: "unavailable", message: "The project could not be read." };
  }
  if (project === undefined) {
    return { ok: false, code: "not_found", message: "No project has this id." };
  }
  return { ok: true, name: sessionNameFor(project.id) };
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
  const url = new URL(request.request.url);
  const path = url.pathname;
  const resolved = await resolveSessionName(request.env, url.searchParams.get("project"));
  if (!resolved.ok) return problem(resolved.code, resolved.message, path);
  const stub = sessionStub(request.env, resolved.name);
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
  const stub = sessionStub(request.env, OBS_SESSION_NAME);
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
  const stub = sessionStub(env, OBS_SESSION_NAME);
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

/**
 * The production dependencies: every face the Worker serves, and nothing a test substitutes.
 *
 * @remarks
 * Exported so a test can read the table a deployment runs: a dependency a test injects (a seam) must
 * not appear here, because reaching the entry would put that substitution in production.
 * @internal
 */
export const dependencies: HandlerDependencies = {
  graphql: createGraphQLFace(),
  ws: forwardToSession,
  obs: forwardObs,
  files: createFilesFace(),
  checkpoints: createCheckpointFace(),
  // The Workspace start-up pass (0272n): each project's object is reached once per isolate, after
  // the first answer, so it exists before a face needs it. The three parts it is built with (the
  // obs sink, the Trail lookup, the mirror reporter) are the object's own, from its bindings.
  workspace: {},
  machineKeys: createKeysFace(),
  conversations: createConversationsFace(lookupConversation),
  onResponse: recordResponse,
};

const edge = createEdge(dependencies);

export default { fetch: edge };
