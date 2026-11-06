// A fetch that answers from committed fixtures, so screens render without server 0035 (D043).
// The fixture bodies are responses to real routes: createWebClient parses them with the same
// parseResponse the server path uses, so a stale fixture fails as a contract violation.
import {
  ProjectIdSchema,
  ROUTES,
  type Project,
  type RouteKey,
  type RouteResponse,
  type State,
  type Task,
} from "@hns/core";
import * as v from "valibot";
import type { JsonRouteKey } from "./transport.ts";

type FixtureResponses = { [K in RouteKey]: RouteResponse<K> };

const projectId = v.parse(ProjectIdSchema, "project-hns");

const state: State = {
  messages: [
    { role: "user", text: "Where are the projects?", timestamp: "2026-11-07T00:00:00.000Z" },
    {
      role: "assistant",
      text: "Two are open.",
      model: "faux/faux-1",
      timestamp: "2026-11-07T00:00:01.000Z",
    },
  ],
  tasks: [{ id: "task-1", kind: "chat", state: "running" }],
  queued: 0,
  scheduling: "running",
  provider: "faux",
  model: "faux-1",
  counts: { conversations: 2, projects: 2 },
};

const projects: Project[] = [
  { id: projectId, name: "hns", created_at: "2026-11-01T00:00:00.000Z" },
];

const tasks: Task[] = [
  {
    id: "task-1",
    project_id: projectId,
    title: "Web の土台",
    status: "doing",
    created_at: "2026-11-07T00:00:00.000Z",
    updated_at: "2026-11-07T00:00:00.000Z",
  },
];

/** The routes the fixture client answers; the rest are 404 until a screen needs them. */
export const FIXTURE_ROUTE_KEYS = [
  "GET /api/state",
  "GET /api/projects",
  "GET /api/tasks",
] as const satisfies readonly JsonRouteKey[];

const FIXTURES: Partial<FixtureResponses> = {
  "GET /api/state": state,
  "GET /api/projects": projects,
  "GET /api/tasks": tasks,
};

// SAFETY: Object.keys(ROUTES) enumerates exactly the RouteKey union.
const ROUTE_KEYS = Object.keys(ROUTES) as readonly RouteKey[];

const PATTERNS = new Map<RouteKey, RegExp>(
  ROUTE_KEYS.map((key) => [key, patternFor(ROUTES[key].path)]),
);

export function createFixtureFetch(): typeof fetch {
  return async (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    // Relative paths are what fixture mode sees (baseUrl ""); the host is never dialed.
    const url = new URL(target, "http://fixtures.invalid");
    const method = (init?.method ?? "GET").toUpperCase();
    const route = matchRoute(method, url.pathname);
    if (route === null) return errorResponse("no fixture for " + method + " " + url.pathname);
    const body = FIXTURES[route];
    if (body === undefined) return errorResponse("no fixture for " + route);
    return jsonResponse(200, body);
  };
}

function matchRoute(method: string, pathname: string): RouteKey | null {
  for (const key of ROUTE_KEYS) {
    if (ROUTES[key].method !== method) continue;
    if (PATTERNS.get(key)?.test(pathname) === true) return key;
  }
  return null;
}

function patternFor(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const source = escaped.replace(/:([A-Za-z0-9_]+)/gu, "[^/]+");
  return new RegExp("^" + source + "$", "u");
}

function jsonResponse<T>(status: number, body: T): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(message: string): Response {
  return jsonResponse(404, { code: "not_found", message });
}
