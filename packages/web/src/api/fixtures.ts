// A fetch that answers from committed fixtures, so screens render without server 0035 (D043).
// The fixture bodies are responses to real routes: createWebClient parses them with the same
// parseResponse the server path uses, so a stale fixture fails as a contract violation.
import {
  ConversationIdSchema,
  ProjectIdSchema,
  ROUTES,
  type Conversation,
  type Project,
  type RouteKey,
  type RouteResponse,
  type State,
  type Task,
  type WorkflowRun,
} from "@hns/core";
import * as v from "valibot";
import type { JsonRouteKey } from "./transport.ts";

type FixtureResponses = { [K in RouteKey]: RouteResponse<K> };

const projectId = v.parse(ProjectIdSchema, "project-hns");
const scratchProjectId = v.parse(ProjectIdSchema, "project-scratch");
const conversationId = v.parse(ConversationIdSchema, "conversation-intent");

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
  { id: scratchProjectId, name: "scratch", created_at: "2026-11-06T00:00:00.000Z" },
];

const conversations: Conversation[] = [
  {
    id: conversationId,
    project_id: projectId,
    title: "Web の土台",
    created_at: "2026-11-07T00:00:00.000Z",
    updated_at: "2026-11-07T00:10:00.000Z",
    archived: false,
    deleted_at: null,
  },
  {
    id: v.parse(ConversationIdSchema, "conversation-design"),
    project_id: projectId,
    title: "デザインシステムのレビュー",
    created_at: "2026-11-07T00:20:00.000Z",
    updated_at: null,
    archived: false,
    deleted_at: null,
  },
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

const runs: WorkflowRun[] = [
  {
    id: "run-1",
    workflow_id: "workflow-release",
    version: 1,
    status: "done",
    input: "リリース準備",
    output: null,
    created_at: "2026-11-06T22:00:00.000Z",
    finished_at: "2026-11-06T22:04:00.000Z",
  },
  {
    id: "run-2",
    workflow_id: "workflow-review",
    version: 3,
    status: "running",
    input: "0101 のレビュー",
    output: null,
    created_at: "2026-11-07T00:30:00.000Z",
    finished_at: null,
  },
];

/** The routes the fixture client answers; the rest are 404 until a screen needs them. */
export const FIXTURE_ROUTE_KEYS = [
  "GET /api/state",
  "GET /api/projects",
  "GET /api/conversations",
  "GET /api/tasks",
  "GET /api/runs",
] as const satisfies readonly JsonRouteKey[];

const FIXTURES: Partial<FixtureResponses> = {
  "GET /api/state": state,
  "GET /api/projects": projects,
  "GET /api/conversations": conversations,
  "GET /api/tasks": tasks,
  "GET /api/runs": runs,
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
    const projectId = url.searchParams.get("projectId");
    // The real routes filter by projectId; fixtures do the same so switching projects looks real.
    if (route === "GET /api/conversations") {
      const list = FIXTURES[route];
      if (list === undefined) return errorResponse("no fixture for " + route);
      return jsonResponse(
        200,
        projectId === null ? list : list.filter((item) => item.project_id === projectId),
      );
    }
    if (route === "GET /api/tasks") {
      const list = FIXTURES[route];
      if (list === undefined) return errorResponse("no fixture for " + route);
      return jsonResponse(
        200,
        projectId === null ? list : list.filter((item) => item.project_id === projectId),
      );
    }
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
