import { readBody } from "./body.ts";
import { REQUEST_ID_HEADER, resolveRequestId, withResponseRequestId } from "./correlation.ts";
import type { WorkerEnv } from "./env.ts";
import { DEFAULT_LIMITS, type EdgeLimits } from "./limits.ts";
import { problem } from "./problem.ts";
import { readSessionCookie, type Session } from "./session.ts";
import { incompleteToolPathMessage, toolPathMode } from "../do/tool-path-mode.ts";

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

/** The files content face additionally receives the workspace its path names. */
export interface FilesRequest extends EdgeRequest {
  readonly workspaceId: string;
}

/**
 * The checkpoint faces additionally receive the workspace their path names and the edge's
 * budgets.
 *
 * @remarks
 * The budgets travel because a pack is refused by its declared length before it is read, and the
 * limit is the edge's (the checkpoint contract's 64 MiB), not a second number the face picks.
 */
export interface CheckpointRequest extends EdgeRequest {
  readonly workspaceId: string;
  readonly limits: EdgeLimits;
}

/** One finished request, as the observability log records it. */
export interface EdgeResponseEvent {
  readonly requestId: string;
  readonly method: string;
  /** The pathname only; the edge never records the query string. */
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
}

/** The handlers owned by the issues that implement each face. */
export interface HandlerDependencies {
  readonly graphql: (request: GraphQLRequest) => Promise<Response>;
  readonly ws: (request: EdgeRequest) => Promise<Response>;
  /**
   * The observability REST face, forwarded to the Session object.
   *
   * @remarks
   * Optional so the face fails closed (503) when the binding is missing, and so an edge test
   * that does not exercise the API needs no stub.
   */
  readonly obs?: ((request: EdgeRequest) => Promise<Response>) | undefined;
  /**
   * The files content face (REST), forwarded to the Workspace object.
   *
   * @remarks
   * Optional so a missing binding or an unwired deployment fails closed (503) instead of
   * crashing, and so an edge test that does not exercise the face needs no stub.
   */
  readonly files?: ((request: FilesRequest, limits: EdgeLimits) => Promise<Response>) | undefined;
  /**
   * The checkpoint face (REST): prepare, the machine's signed pack, and complete, forwarded to
   * the Workspace object.
   *
   * @remarks
   * Optional, like every face, so a missing binding is a 503 instead of a crash. The pack's
   * bytes are forwarded unchanged; the object authenticates them.
   */
  readonly checkpoints?: ((request: CheckpointRequest) => Promise<Response>) | undefined;
  /**
   * The conversations face (0119): one conversation's metadata, from the D1 index.
   *
   * @remarks
   * Optional, like every face, so a deployment that does not wire it answers 503 instead of
   * crashing. The face reads the row; it does not ask the Session object, because the row is what
   * names a conversation (D078) and a read of the object first could disagree with it.
   */
  readonly conversations?: ((request: EdgeRequest) => Promise<Response>) | undefined;
  /**
   * The machines face (0148): the control-plane public keys a machine enrolls with.
   *
   * @remarks
   * Optional, like every face. It is served only to a session (D059): the keys are public but the
   * deployment they name is not, and the edge answers 401 before this handler runs.
   */
  readonly machineKeys?: ((request: EdgeRequest) => Promise<Response>) | undefined;
  /** Called once per request; production forwards the entry to the Session object. */
  readonly onResponse?: ((event: EdgeResponseEvent, env: WorkerEnv) => void) | undefined;
}

/** The fetch signature the Worker module exposes. */
export type EdgeFetch = (request: Request, env: WorkerEnv) => Promise<Response>;

/** The files content face: `/api/workspaces/<workspaceId>/files`. */
const FILES_PATH = /^\/api\/workspaces\/([^/]+)\/files$/u;

/** The checkpoint face: `/api/workspaces/<workspaceId>/checkpoints/...`. */
const CHECKPOINTS_PATH = /^\/api\/workspaces\/([^/]+)\/checkpoints(?:\/|$)/u;

/** The conversations face: `/api/conversations/<id>` and its sub-paths (0119). */
const CONVERSATIONS_PATH = /^\/api\/conversations(?:\/|$)/u;

/** The cache policy for Vite's content-hashed files under `/assets`. */
const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** The index must be revalidated so a deploy is visible on the next load. */
const INDEX_CACHE_CONTROL = "no-cache";

/**
 * The headers attached to the HTML shell.
 *
 * @remarks
 * The shell renders model data as text, so scripts are limited to the hashed bundle Vite
 * emits and no inline script is allowed (D094 / D096). Styles allow inline style attributes
 * because the design system sets CSS variables inline.
 */
const SHELL_SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
} as const;

/** The path prefixes the SPA fallback must never answer. */
const NON_SPA_PREFIXES = ["/assets", "/api", "/graphql", "/ws"] as const;

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

/** Whether the caller asked for an HTML document (a navigation). */
function wantsHtml(request: Request): boolean {
  const accept = request.headers.get("accept");
  return accept !== null && accept.toLowerCase().includes("text/html");
}

/** Whether a path may be answered by the SPA fallback instead of a 404. */
function isSpaPath(path: string): boolean {
  return !NON_SPA_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + "/"));
}

/** Whether the asset layer answered with an HTML document. */
function isHtmlResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/html") ?? false;
}

/** Copy a response, replacing the named headers. */
function withHeaders(response: Response, headers: Readonly<Record<string, string>>): Response {
  const copy = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) copy.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: copy,
  });
}

/** Apply the cache and security headers an asset response needs. */
function decorateAsset(response: Response, path: string): Response {
  if (response.status !== 200 && response.status !== 304) return response;
  if (path.startsWith("/assets/")) {
    return withHeaders(response, { "cache-control": ASSET_CACHE_CONTROL });
  }
  if (!isHtmlResponse(response)) return response;
  return withHeaders(response, {
    ...SHELL_SECURITY_HEADERS,
    "cache-control": INDEX_CACHE_CONTROL,
  });
}

/**
 * Serve a static request, falling back to `index.html` for a client-side route.
 *
 * @internal
 * @remarks
 * Only a navigation (GET/HEAD + `Accept: text/html`) whose asset is missing becomes the
 * shell. `/assets`, `/api`, `/graphql`, and `/ws` keep their own 404s, so a missing script
 * is not answered with HTML and the API never grows a catch-all (D094). The index is fetched
 * from the asset layer as `/index.html` so the documented no-cache policy applies to the
 * fallback too.
 */
async function serveStatic(
  request: Request,
  env: WorkerEnv,
  path: string,
  signal: AbortSignal,
): Promise<Response> {
  const assets = env.ASSETS;
  if (assets === undefined) {
    return problem("not_found", "Static assets are not configured.", path);
  }
  const response = await assets.fetch(new Request(request, { signal }));
  const navigable = request.method === "GET" || request.method === "HEAD";
  if (response.status !== 404 || !navigable || !wantsHtml(request) || !isSpaPath(path)) {
    return decorateAsset(response, path);
  }
  const index = await assets.fetch(
    new Request(new URL("/index.html", request.url), {
      method: request.method,
      headers: request.headers,
      signal,
    }),
  );
  if (index.status === 404) return response;
  return withHeaders(index, {
    ...SHELL_SECURITY_HEADERS,
    "cache-control": INDEX_CACHE_CONTROL,
  });
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
  const files = FILES_PATH.exec(path);
  if (files !== null) {
    if (request.method !== "GET" && request.method !== "POST") {
      const response = problem(
        "method_not_allowed",
        "Only GET and POST are allowed on this path.",
        path,
      );
      response.headers.set("allow", "GET, POST");
      return response;
    }
    const session = await authenticate(request, env);
    if (session === null) {
      return problem("unauthorized", "A valid session cookie is required.", path);
    }
    if (dependencies.files === undefined) {
      return problem("unavailable", "The files face is not configured.", path);
    }
    return dependencies.files(
      {
        request,
        env,
        session,
        requestId,
        signal,
        workspaceId: files[1] ?? "",
      },
      limits,
    );
  }
  const checkpoints = CHECKPOINTS_PATH.exec(path);
  if (checkpoints !== null) {
    const session = await authenticate(request, env);
    if (session === null) {
      return problem("unauthorized", "A valid session cookie is required.", path);
    }
    if (request.method !== "POST") {
      // Authenticated first, so an anonymous caller learns nothing about the face's shape:
      // every method is a 401 without a session, as it is for every other face (D059).
      const response = problem("method_not_allowed", "Only POST is allowed on this path.", path);
      response.headers.set("allow", "POST");
      return response;
    }
    if (dependencies.checkpoints === undefined) {
      return problem("unavailable", "The checkpoint face is not configured.", path);
    }
    return dependencies.checkpoints({
      request,
      env,
      session,
      requestId,
      signal,
      workspaceId: checkpoints[1] ?? "",
      limits,
    });
  }
  if (path === "/api/machines/keys") {
    if (request.method !== "GET") return methodNotAllowed("GET", path);
    const session = await authenticate(request, env);
    if (session === null) {
      return problem("unauthorized", "A valid session cookie is required.", path);
    }
    if (dependencies.machineKeys === undefined) {
      return problem("unavailable", "The machines face is not configured.", path);
    }
    return dependencies.machineKeys({ request, env, session, requestId, signal });
  }
  if (CONVERSATIONS_PATH.test(path)) {
    // Authenticated before the method and before the face, as every REST face is (D059): an
    // anonymous caller learns nothing about the path's shape, only that a session is required.
    const session = await authenticate(request, env);
    if (session === null) {
      return problem("unauthorized", "A valid session cookie is required.", path);
    }
    if (request.method !== "GET") {
      const response = problem("method_not_allowed", "Only GET is allowed on this path.", path);
      response.headers.set("allow", "GET");
      return response;
    }
    if (dependencies.conversations === undefined) {
      return problem("unavailable", "The conversations face is not configured.", path);
    }
    return dependencies.conversations({ request, env, session, requestId, signal });
  }
  if (path === "/api/events" || path === "/api/metrics") {
    if (request.method !== "GET") return methodNotAllowed("GET", path);
    const session = await authenticate(request, env);
    if (session === null) {
      return problem("unauthorized", "A valid session cookie is required.", path);
    }
    if (dependencies.obs === undefined) {
      return problem("unavailable", "The observability face is not configured.", path);
    }
    return dependencies.obs({ request, env, session, requestId, signal });
  }
  if (path === "/api" || path.startsWith("/api/")) {
    return problem("not_found", "No route matches this path.", path);
  }
  if (request.method === "GET" || request.method === "HEAD") {
    return serveStatic(request, env, path, signal);
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
    const started = Date.now();
    const controller = new AbortController();
    let response: Response;
    // The three bindings of the granted tool path are a set (0270n). A deployment that sets some
    // of them must not serve anything: every face that ran would run it in the state the operator
    // did not ask for (the Phase 0 tools on the Session objects, no grant on the Worker). The
    // answer is the same 503 on every path, before authentication, so a half-configured deploy is
    // visible from a health check and never looks like a working one.
    const mode = toolPathMode(env);
    if (mode.kind === "incomplete") {
      response = problem("unavailable", incompleteToolPathMessage(mode), path);
    } else {
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
            "DEBUGEDGE",
            String(error),
            error instanceof Error ? String(error.stack) : "",
          );
          console.error(
            "edge: unhandled request",
            requestId,
            error instanceof Error ? error.name : "unknown",
          );
          response = problem("internal", "Unexpected failure.", path);
        }
      }
    }
    const decorated = withResponseRequestId(response, requestId);
    try {
      dependencies.onResponse?.(
        {
          requestId,
          method: request.method,
          path,
          status: decorated.status,
          durationMs: Date.now() - started,
        },
        env,
      );
    } catch (error) {
      // Observation is a side effect: a logging bug must not turn a served request into a 500.
      console.error(
        "edge: response log failed",
        requestId,
        error instanceof Error ? error.name : "unknown",
      );
    }
    return decorated;
  };
}
