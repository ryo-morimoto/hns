import assert from "node:assert/strict";
import { expect, test, vi } from "vitest";
import { assetsWith, d1With, envWith, sessionCookie } from "../../test/support/edge.ts";
import {
  createEdge,
  type EdgeRequest,
  type EdgeResponseEvent,
  type FilesRequest,
  type GraphQLRequest,
  type HandlerDependencies,
} from "./handler.ts";
import type { AssetFetcher } from "./env.ts";
import { DEFAULT_LIMITS } from "./limits.ts";

const BASE = "https://hns.test";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(BASE + path, { headers });
}

function post(path: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(BASE + path, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface Calls {
  readonly graphql: GraphQLRequest[];
  readonly ws: EdgeRequest[];
}

interface Recording {
  readonly calls: Calls;
  readonly deps: HandlerDependencies;
}

function recordingDeps(response: Response = new Response("ok", { status: 200 })): Recording {
  const calls: Calls = { graphql: [], ws: [] };
  const deps: HandlerDependencies = {
    graphql(request: GraphQLRequest): Promise<Response> {
      calls.graphql.push(request);
      return Promise.resolve(response);
    },
    ws(request: EdgeRequest): Promise<Response> {
      calls.ws.push(request);
      return Promise.resolve(response);
    },
  };
  return { calls, deps };
}

async function expectProblem(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code });
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
}

interface FakeAssets {
  readonly fetcher: AssetFetcher;
  readonly requests: string[];
}

/** An asset layer that answers by pathname; an unknown path is a 404 like the real one. */
function assetsAt(routes: Readonly<Record<string, () => Response>>): FakeAssets {
  const requests: string[] = [];
  return {
    requests,
    fetcher: {
      fetch(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname;
        requests.push(path);
        const make = routes[path];
        if (make === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
        const response = make();
        if (request.method === "HEAD") {
          return Promise.resolve(
            new Response(null, { status: response.status, headers: response.headers }),
          );
        }
        return Promise.resolve(response);
      },
    },
  };
}

const indexHtml = (): Response =>
  new Response('<!doctype html><div id="root"></div>', {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const hashedScript = (): Response =>
  new Response("console.log(1)", {
    status: 200,
    headers: { "content-type": "text/javascript" },
  });

// Catches: an unauthenticated request reaching a face handler.
test("an unauthenticated GraphQL request is denied before the handler", async () => {
  const { calls, deps } = recordingDeps();
  const response = await createEdge(deps)(post("/graphql", "{}"), envWith());
  await expectProblem(response, 401, "unauthorized");
  expect(calls.graphql).toHaveLength(0);
  expect(response.headers.get("x-request-id")).toMatch(UUID);
});

test("a valid session reaches the GraphQL handler with the body and request id", async () => {
  const cookie = await sessionCookie("owner");
  const { calls, deps } = recordingDeps();
  const response = await createEdge(deps)(
    post("/graphql", '{"query":"{ok}"}', { cookie }),
    envWith(),
  );
  expect(response.status).toBe(200);
  const called = calls.graphql.at(0);
  assert.ok(called !== undefined);
  expect(called.body).toBe('{"query":"{ok}"}');
  expect(called.session.subject).toBe("owner");
  expect(called.requestId).toBe(response.headers.get("x-request-id"));
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
});

// Catches: a client-supplied correlation id that is not validated.
test("a valid inbound request id is reused and an invalid one is replaced", async () => {
  const cookie = await sessionCookie("owner");
  const { deps } = recordingDeps();
  const edge = createEdge(deps);
  const reused = await edge(
    post("/graphql", "{}", { cookie, "x-request-id": "caller-1" }),
    envWith(),
  );
  expect(reused.headers.get("x-request-id")).toBe("caller-1");
  const replaced = await edge(
    post("/graphql", "{}", { cookie, "x-request-id": "bad id" }),
    envWith(),
  );
  expect(replaced.headers.get("x-request-id")).not.toBe("bad id");
  expect(replaced.headers.get("x-request-id")).toMatch(UUID);
});

test("GET /graphql is 405 with Allow: POST", async () => {
  const { calls, deps } = recordingDeps();
  const response = await createEdge(deps)(get("/graphql"), envWith());
  await expectProblem(response, 405, "method_not_allowed");
  expect(response.headers.get("allow")).toBe("POST");
  expect(calls.graphql).toHaveLength(0);
});

test("OPTIONS /graphql is 405 without CORS headers", async () => {
  const { deps } = recordingDeps();
  const response = await createEdge(deps)(
    new Request(BASE + "/graphql", { method: "OPTIONS" }),
    envWith(),
  );
  await expectProblem(response, 405, "method_not_allowed");
  expect(response.headers.get("access-control-allow-methods")).toBeNull();
});

test("POST /ws is 405 with Allow: GET", async () => {
  const { deps } = recordingDeps();
  const response = await createEdge(deps)(post("/ws", "{}"), envWith());
  await expectProblem(response, 405, "method_not_allowed");
  expect(response.headers.get("allow")).toBe("GET");
});

test("GET /ws without a session is denied before the handler", async () => {
  const { calls, deps } = recordingDeps();
  const response = await createEdge(deps)(get("/ws"), envWith());
  await expectProblem(response, 401, "unauthorized");
  expect(calls.ws).toHaveLength(0);
});

test("GET /ws with a session reaches the ws handler", async () => {
  const cookie = await sessionCookie("owner");
  const { calls, deps } = recordingDeps(new Response("upgraded", { status: 200 }));
  const response = await createEdge(deps)(get("/ws", { cookie }), envWith());
  expect(response.status).toBe(200);
  const called = calls.ws.at(0);
  assert.ok(called !== undefined);
  expect(called.session.subject).toBe("owner");
  expect(called.requestId).toBe(response.headers.get("x-request-id"));
});

// Catches: a deep link losing the shell on reload, or the shell being cached across a deploy.
test("a navigation to an unknown path is answered with the no-cache shell", async () => {
  const assets = assetsAt({ "/index.html": indexHtml });
  const response = await createEdge(recordingDeps().deps)(
    get("/p/a/c/b", { accept: "text/html,application/xhtml+xml" }),
    envWith({ assets: assets.fetcher }),
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('id="root"');
  expect(assets.requests).toStrictEqual(["/p/a/c/b", "/index.html"]);
  expect(response.headers.get("cache-control")).toBe("no-cache");
  expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("same-origin");
  expect(response.headers.get("permissions-policy")).toContain("camera=()");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
});

// Catches: a missing hashed script answered with HTML, which hides a broken deploy.
test("a hashed asset is immutable and a missing asset stays a 404", async () => {
  const assets = assetsAt({ "/assets/app-abc123.js": hashedScript });
  const edge = createEdge(recordingDeps().deps);
  const asset = await edge(get("/assets/app-abc123.js"), envWith({ assets: assets.fetcher }));
  expect(asset.status).toBe(200);
  expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

  const missing = await edge(
    get("/assets/missing.js", { accept: "text/html" }),
    envWith({ assets: assets.fetcher }),
  );
  expect(missing.status).toBe(404);
  expect(await missing.text()).not.toContain('id="root"');
  expect(assets.requests).toStrictEqual(["/assets/app-abc123.js", "/assets/missing.js"]);
});

// Catches: the SPA fallback swallowing a missing asset instead of only a navigation.
test("only a navigation falls back to the shell", async () => {
  const assets = assetsAt({ "/index.html": indexHtml });
  const edge = createEdge(recordingDeps().deps);
  const plain = await edge(get("/unknown"), envWith({ assets: assets.fetcher }));
  expect(plain.status).toBe(404);
  const navigation = await edge(
    get("/unknown", { accept: "text/html" }),
    envWith({ assets: assets.fetcher }),
  );
  expect(navigation.status).toBe(200);
  expect(await navigation.text()).toContain('id="root"');
  expect(assets.requests).toStrictEqual(["/unknown", "/unknown", "/index.html"]);
});

// Catches: the login route being a 404 instead of the shell that 0108 mounts.
test("GET /login is served the shell", async () => {
  const assets = assetsAt({ "/index.html": indexHtml });
  const response = await createEdge(recordingDeps().deps)(
    get("/login?next=%2Fp%2Fa", { accept: "text/html" }),
    envWith({ assets: assets.fetcher }),
  );
  expect(response.status).toBe(200);
  expect(assets.requests).toStrictEqual(["/login", "/index.html"]);
  expect(response.headers.get("cache-control")).toBe("no-cache");
});

// Catches: the fallback answering an API or WebSocket path with the HTML shell.
test("the faces and /assets are never answered by the shell", async () => {
  const assets = assetsAt({ "/index.html": indexHtml });
  const edge = createEdge(recordingDeps().deps);
  const env = envWith({ assets: assets.fetcher });

  await expectProblem(
    await edge(get("/api/unknown", { accept: "text/html" }), env),
    404,
    "not_found",
  );
  await expectProblem(
    await edge(get("/graphql", { accept: "text/html" }), env),
    405,
    "method_not_allowed",
  );
  await expectProblem(await edge(get("/ws", { accept: "text/html" }), env), 401, "unauthorized");
  expect((await edge(get("/assets", { accept: "text/html" }), env)).status).toBe(404);
  expect((await edge(get("/graphql/", { accept: "text/html" }), env)).status).toBe(404);
  expect(assets.requests).toStrictEqual(["/assets", "/graphql/"]);
});

// Catches: the root document being cached across a deploy.
test("the root document is revalidated", async () => {
  const assets = assetsAt({ "/": indexHtml, "/index.html": indexHtml });
  const response = await createEdge(recordingDeps().deps)(
    get("/", { accept: "text/html" }),
    envWith({ assets: assets.fetcher }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-cache");
  expect(assets.requests).toStrictEqual(["/"]);
});

test("a HEAD navigation gets the shell headers and no body", async () => {
  const assets = assetsAt({ "/index.html": indexHtml });
  const response = await createEdge(recordingDeps().deps)(
    new Request(BASE + "/p/a", { method: "HEAD", headers: { accept: "text/html" } }),
    envWith({ assets: assets.fetcher }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-cache");
  expect(await response.text()).toBe("");
  expect(assets.requests).toStrictEqual(["/p/a", "/index.html"]);
});

// Catches: a signed-out browser being unable to load the app shell.
test("a static GET is public and delegated to ASSETS", async () => {
  const assets = assetsWith();
  const response = await createEdge(recordingDeps().deps)(
    get("/"),
    envWith({ assets: assets.fetcher }),
  );
  expect(response.status).toBe(200);
  expect(assets.requests).toHaveLength(1);
  expect(assets.requests[0]?.url).toBe(BASE + "/");
});

test("a trailing slash is not a face", async () => {
  const assets = assetsWith(new Response("not found", { status: 404 }));
  const response = await createEdge(recordingDeps().deps)(
    get("/graphql/"),
    envWith({ assets: assets.fetcher }),
  );
  expect(response.status).toBe(404);
  expect(response.headers.get("x-request-id")).toMatch(UUID);
  expect(assets.requests).toHaveLength(1);
});

test("a static GET without ASSETS is 404", async () => {
  const response = await createEdge(recordingDeps().deps)(get("/"), envWith());
  await expectProblem(response, 404, "not_found");
});

test("an unknown POST is 404 and does not reach ASSETS or a face", async () => {
  const assets = assetsWith();
  const { calls, deps } = recordingDeps();
  const response = await createEdge(deps)(post("/", "{}"), envWith({ assets: assets.fetcher }));
  await expectProblem(response, 404, "not_found");
  expect(assets.requests).toHaveLength(0);
  expect(calls.graphql).toHaveLength(0);
  expect(calls.ws).toHaveLength(0);
});

test("the observability API requires a session and only GET", async () => {
  const observed: EdgeRequest[] = [];
  const deps: HandlerDependencies = {
    graphql: () => Promise.resolve(new Response("ok")),
    ws: () => Promise.resolve(new Response("ok")),
    obs(request: EdgeRequest): Promise<Response> {
      observed.push(request);
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    },
  };
  const edge = createEdge(deps);
  for (const path of ["/api/events", "/api/metrics"]) {
    const denied = await edge(get(path), envWith());
    await expectProblem(denied, 401, "unauthorized");
    const wrong = await edge(post(path, "{}"), envWith());
    await expectProblem(wrong, 405, "method_not_allowed");
    expect(wrong.headers.get("allow")).toBe("GET");
  }
  expect(observed).toHaveLength(0);

  const cookie = await sessionCookie("owner");
  const allowed = await edge(
    get("/api/events?limit=5", { cookie, "x-request-id": "caller-1" }),
    envWith(),
  );
  expect(allowed.status).toBe(200);
  expect(observed).toHaveLength(1);
  expect(observed[0]?.requestId).toBe("caller-1");
  expect(observed[0]?.session.subject).toBe("owner");
  expect(allowed.headers.get("x-request-id")).toBe("caller-1");
});

// Catches: an /api face looking configured while the Session binding is absent.
test("the observability API fails closed without a Session binding", async () => {
  const cookie = await sessionCookie("owner");
  const response = await createEdge(recordingDeps().deps)(
    get("/api/metrics", { cookie }),
    envWith(),
  );
  await expectProblem(response, 503, "unavailable");
});

// Catches: the worker hop recording a query string, a body, or a header.
test("the edge records the pathname and the status, never the query or the body", async () => {
  const recorded: EdgeResponseEvent[] = [];
  const deps: HandlerDependencies = {
    graphql: () => Promise.resolve(new Response("ok", { status: 200 })),
    ws: () => Promise.resolve(new Response("ok")),
    onResponse(event: EdgeResponseEvent): void {
      recorded.push(event);
    },
  };
  const cookie = await sessionCookie("owner");
  const edge = createEdge(deps);
  await edge(get("/api/debug?token=super-secret", { cookie }), envWith());
  await edge(post("/graphql", '{"query":"super-secret"}', { cookie }), envWith());
  expect(recorded).toHaveLength(2);
  expect(recorded[0]).toMatchObject({ method: "GET", path: "/api/debug", status: 404 });
  expect(recorded[1]).toMatchObject({ method: "POST", path: "/graphql", status: 200 });
  const text = JSON.stringify(recorded);
  expect(text).not.toContain("super-secret");
  expect(text).not.toContain("token");
  expect(recorded.every((event) => event.requestId.length > 0)).toBe(true);
  expect(recorded.every((event) => event.durationMs >= 0)).toBe(true);
});

// Catches: a debug route reappearing under /api.
test("/api paths are not a face for any method", async () => {
  const assets = assetsWith();
  const edge = createEdge(recordingDeps().deps);
  for (const request of [get("/api/debug"), post("/api/debug", "{}")]) {
    const response = await edge(request, envWith({ assets: assets.fetcher }));
    await expectProblem(response, 404, "not_found");
  }
  expect(assets.requests).toHaveLength(0);
});

test("an oversized body is refused before the handler", async () => {
  const cookie = await sessionCookie("owner");
  const { calls, deps } = recordingDeps();
  const response = await createEdge(deps, { ...DEFAULT_LIMITS, maxBodyBytes: 4 })(
    post("/graphql", "12345", { cookie }),
    envWith(),
  );
  await expectProblem(response, 413, "payload_too_large");
  expect(calls.graphql).toHaveLength(0);
});

test("a non-JSON body is refused before the handler", async () => {
  const cookie = await sessionCookie("owner");
  const { calls, deps } = recordingDeps();
  const response = await createEdge(deps)(
    post("/graphql", "{}", { cookie, "content-type": "text/plain" }),
    envWith(),
  );
  await expectProblem(response, 415, "unsupported_media_type");
  expect(calls.graphql).toHaveLength(0);
});

// Catches: a bearer token or query token standing in for the session cookie.
// Catches: a signed cookie accepted when the Worker has no signing key.
test("a missing session secret denies a signed cookie", async () => {
  const cookie = await sessionCookie("owner");
  const response = await createEdge(recordingDeps().deps)(
    post("/graphql", "{}", { cookie }),
    envWith({ secret: "" }),
  );
  await expectProblem(response, 401, "unauthorized");
});

test("a bearer token is not a session", async () => {
  const response = await createEdge(recordingDeps().deps)(
    post("/graphql", "{}", { authorization: "Bearer secret" }),
    envWith(),
  );
  await expectProblem(response, 401, "unauthorized");
});

test("an expired session is denied", async () => {
  const cookie = await sessionCookie("owner", Date.now() - 1);
  const response = await createEdge(recordingDeps().deps)(
    post("/graphql", "{}", { cookie }),
    envWith(),
  );
  await expectProblem(response, 401, "unauthorized");
});

test("an unexpected handler failure becomes a 500 with the request id", async () => {
  const cookie = await sessionCookie("owner");
  const deps: HandlerDependencies = {
    graphql(): Promise<Response> {
      return Promise.reject(new Error("boom"));
    },
    ws(): Promise<Response> {
      return Promise.resolve(new Response("ok"));
    },
  };
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const response = await createEdge(deps)(post("/graphql", "{}", { cookie }), envWith());
    await expectProblem(response, 500, "internal");
    expect(response.headers.get("x-request-id")).toMatch(UUID);
  } finally {
    spy.mockRestore();
  }
});

// Catches: the D1 binding being dropped at the edge, so no face can reach the store.
test("a face receives the D1 binding from env", async () => {
  const cookie = await sessionCookie("owner");
  const db = d1With();
  let seen: unknown;
  const deps: HandlerDependencies = {
    graphql(request: GraphQLRequest): Promise<Response> {
      seen = request.env.DB;
      return Promise.resolve(new Response("ok"));
    },
    ws(): Promise<Response> {
      return Promise.resolve(new Response("ok"));
    },
  };
  const response = await createEdge(deps)(post("/graphql", "{}", { cookie }), envWith({ db }));
  expect(response.status).toBe(200);
  expect(seen).toBe(db);
});

// Catches: a slow resolver holding the request past the deadline without cancellation.
test("a handler past the deadline returns 504 and aborts the signal", async () => {
  const cookie = await sessionCookie("owner");
  let seen: AbortSignal | undefined;
  const deps: HandlerDependencies = {
    async graphql(request: GraphQLRequest): Promise<Response> {
      seen = request.signal;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response("late");
    },
    ws(): Promise<Response> {
      return Promise.resolve(new Response("ok"));
    },
  };
  const response = await createEdge(deps, { ...DEFAULT_LIMITS, maxRequestMs: 5 })(
    post("/graphql", "{}", { cookie }),
    envWith(),
  );
  await expectProblem(response, 504, "timeout");
  assert.ok(seen !== undefined);
  expect(seen.aborted).toBe(true);
});
// Catches: the files route answering before authentication, serving a method it does not
// support, or matching a deeper path than the one it owns.
test("the files face requires a session and only GET or POST", async () => {
  const calls: FilesRequest[] = [];
  const passed: number[] = [];
  const deps: HandlerDependencies = {
    ...recordingDeps().deps,
    files(request: FilesRequest, limits): Promise<Response> {
      calls.push(request);
      passed.push(limits.maxBodyBytes);
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    },
  };
  const edge = createEdge(deps);
  const anonymous = await edge(post("/api/workspaces/w1/files", '{"path":"a.txt"}'), envWith());
  await expectProblem(anonymous, 401, "unauthorized");
  expect(calls).toHaveLength(0);

  const wrong = await edge(
    new Request(BASE + "/api/workspaces/w1/files", { method: "PUT" }),
    envWith(),
  );
  expect(wrong.status).toBe(405);
  expect(wrong.headers.get("allow")).toBe("GET, POST");
  expect(calls).toHaveLength(0);

  const cookie = await sessionCookie("owner");
  const ok = await edge(get("/api/workspaces/w1/files?path=a.txt", { cookie }), envWith());
  expect(ok.status).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.workspaceId).toBe("w1");
  expect(calls[0]?.requestId).toBe(ok.headers.get("x-request-id"));
  expect(calls[0]?.session.subject).toBe("owner");
  // Catches: a face reading a body with a different limit than the edge enforces.
  expect(passed[0]).toBe(DEFAULT_LIMITS.maxBodyBytes);

  const unknown = await edge(get("/api/workspaces/w1/files/extra", { cookie }), envWith());
  await expectProblem(unknown, 404, "not_found");
});

test("the files face fails closed without its dependency", async () => {
  const cookie = await sessionCookie("owner");
  const response = await createEdge(recordingDeps().deps)(
    get("/api/workspaces/w1/files?path=a.txt", { cookie }),
    envWith(),
  );
  await expectProblem(response, 503, "unavailable");
});
