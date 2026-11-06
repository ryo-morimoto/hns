import { test } from "vitest";
import assert from "node:assert/strict";
import * as v from "valibot";
import {
  AutomationCreateSchema,
  AutomationSchema,
  ConversationSchema,
  EventSchema,
  FileEntrySchema,
  HealthSchema,
  MeSchema,
  MessageSchema,
  MetricsSchema,
  MutationResultSchema,
  PasskeyRegisterVerifySchema,
  ROUTES,
  SecretSchema,
  StateEventSchema,
  StateSchema,
  UsageSchema,
  WorkflowGraphSchema,
  WorkflowRunSchema,
  WorkflowSchema,
} from "../src/http-schemas.ts";

const at = "2026-11-07T00:00:00.000Z";

const state = {
  messages: [{ role: "user", text: "hello", timestamp: at }],
  tasks: [{ id: "t1", kind: "agent", state: "running" }],
  queued: 0,
  scheduling: "running",
  provider: "faux",
  model: "faux",
  counts: { conversations: 1, projects: 1 },
};

test("a state snapshot parses", () => {
  const parsed = v.parse(StateSchema, state);

  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.scheduling, "running");
});

test("a state snapshot rejects an unknown scheduling value", () => {
  assert.throws(() => v.parse(StateSchema, { ...state, scheduling: "idle" }));
});

test("an SSE state event parses", () => {
  const parsed = v.parse(StateEventSchema, { event: "state", data: state });

  assert.equal(parsed.event, "state");
});

test("an SSE event rejects an unknown name", () => {
  assert.throws(() => v.parse(StateEventSchema, { event: "progress", data: state }));
});

test("messages parse by role", () => {
  const parsed = v.parse(MessageSchema, {
    role: "tool",
    toolName: "read_file",
    text: "ok",
    timestamp: at,
  });

  assert.equal(parsed.role, "tool");
  assert.throws(() => v.parse(MessageSchema, { role: "system", text: "no", timestamp: at }));
});

test("a project conversation parses", () => {
  const parsed = v.parse(ConversationSchema, {
    id: "c1",
    project_id: "p1",
    title: "conversation",
    created_at: at,
    updated_at: null,
    archived: false,
    deleted_at: null,
  });

  assert.equal(parsed.archived, false);
});

test("a health response parses with a refused sandbox", () => {
  const parsed = v.parse(HealthSchema, {
    ok: true,
    version: "0.1.0",
    provider: "ollama",
    model: "gpt-oss:120b",
    auth: "token",
    sandbox: {
      backend: "bubblewrap",
      platform: "linux",
      shell: "/bin/sh",
      checkedAt: at,
      available: false,
      exec: "disabled",
      bwrap: "bwrap",
      userNamespaces: "blocked",
      code: "not-found",
      reason: "bwrap is not on PATH",
    },
    limits: { turnsPerMinute: 0, dailyTokenBudget: 0, turnTimeoutMs: 0 },
  });

  assert.equal(parsed.sandbox.exec, "disabled");
});

test("a health response rejects an unknown auth mode", () => {
  assert.throws(() =>
    v.parse(HealthSchema, {
      ok: true,
      version: "0.1.0",
      provider: "ollama",
      model: "m",
      auth: "magic",
      sandbox: {
        backend: "bubblewrap",
        platform: "linux",
        shell: "/bin/sh",
        checkedAt: at,
        available: false,
        exec: "disabled",
        bwrap: "bwrap",
        userNamespaces: "unknown",
        reason: "no",
      },
      limits: { turnsPerMinute: 0, dailyTokenBudget: 0, turnTimeoutMs: 0 },
    }),
  );
});

test("an event parses and keeps its detail", () => {
  const parsed = v.parse(EventSchema, {
    id: "e1",
    at,
    level: "info",
    event: "chat.rate_limited",
    request_id: "r1",
    conversation_id: "c1",
    status: 429,
    duration_ms: 12,
    detail: { retryAfterMs: 1000 },
  });

  assert.deepEqual(parsed.detail, { retryAfterMs: 1000 });
});

test("an event rejects an unknown event name", () => {
  assert.throws(() =>
    v.parse(EventSchema, {
      id: "e1",
      at,
      level: "info",
      event: "chat.exploded",
      request_id: null,
      conversation_id: null,
      status: null,
      duration_ms: null,
      detail: null,
    }),
  );
});

test("an event rejects a non-ISO timestamp", () => {
  assert.throws(() =>
    v.parse(EventSchema, {
      id: "e1",
      at: "yesterday",
      level: "info",
      event: "http",
      request_id: null,
      conversation_id: null,
      status: null,
      duration_ms: null,
      detail: null,
    }),
  );
});

test("metrics parse with empty lists", () => {
  const parsed = v.parse(MetricsSchema, {
    http: { total: 0, byStatus: [], p50ms: 0, p95ms: 0 },
    chats: {},
    workflowRuns: [],
    firings: [],
    toolCalls: 0,
    toolErrors: 0,
    agentResponses: 0,
    errors: 0,
    tokensToday: { turns: 0, tokens: 0, cost: 0 },
    byEvent: [],
  });

  assert.equal(parsed.http.total, 0);
});

test("usage parses with model buckets", () => {
  const parsed = v.parse(UsageSchema, {
    session: {
      models: {
        "ollama/gpt-oss:120b": {
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 3,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      tools: {},
    },
    today: { turns: 1, tokens: 3, cost: 0 },
    limits: { turnsPerMinute: 10, dailyTokenBudget: 1000, turnTimeoutMs: 1000 },
  });

  assert.equal(parsed.session.models["ollama/gpt-oss:120b"]?.totalTokens, 3);
});

test("a file entry parses", () => {
  const parsed = v.parse(FileEntrySchema, { path: "src/a.ts", kind: "file" });

  assert.equal(parsed.kind, "file");
  assert.throws(() => v.parse(FileEntrySchema, { path: "src/a.ts", kind: "device" }));
});

test("a mutation result parses every status", () => {
  assert.equal(
    v.parse(MutationResultSchema, { status: "applied", operationId: "o1", version: "sha256:aa" })
      .status,
    "applied",
  );
  assert.equal(
    v.parse(MutationResultSchema, {
      status: "conflict",
      operationId: "o1",
      currentVersion: "sha256:bb",
    }).status,
    "conflict",
  );
  assert.equal(
    v.parse(MutationResultSchema, { status: "unknown", operationId: "o1", reason: "crash" }).status,
    "unknown",
  );
  assert.throws(() => v.parse(MutationResultSchema, { status: "lost", operationId: "o1" }));
});

test("a secret parses only with a known scope", () => {
  const parsed = v.parse(SecretSchema, { scope: "user", name: "ollama.key", value: "v" });

  assert.equal(parsed.scope, "user");
  assert.throws(() => v.parse(SecretSchema, { scope: "world", name: "x", value: "v" }));
});

test("me parses logged out", () => {
  const parsed = v.parse(MeSchema, { user: null, unlocked: false, hasWrapped: false });

  assert.equal(parsed.user, null);
});

test("a workflow graph needs a prompt for an agent node", () => {
  assert.throws(() =>
    v.parse(WorkflowGraphSchema, { nodes: [{ id: "a", type: "agent" }], edges: [] }),
  );
  const parsed = v.parse(WorkflowGraphSchema, {
    nodes: [
      { id: "a", type: "agent", prompt: "do it" },
      { id: "b", type: "tool", command: "printf ok" },
    ],
    edges: [{ from: "a", to: "b" }],
  });

  assert.equal(parsed.nodes.length, 2);
});

test("a workflow parses with its graph", () => {
  const parsed = v.parse(WorkflowSchema, {
    id: "w1",
    project_id: "p1",
    name: "workflow",
    version: 1,
    graph: { nodes: [{ id: "a", type: "human", prompt: "approve" }], edges: [] },
    created_at: at,
    updated_at: at,
  });

  assert.equal(parsed.version, 1);
});

test("a workflow run includes nodes when asked", () => {
  const run = v.parse(WorkflowRunSchema, {
    id: "r1",
    workflow_id: "w1",
    version: 1,
    status: "done",
    input: "",
    output: "{}",
    created_at: at,
    finished_at: at,
    nodes: [
      {
        node_id: "a",
        status: "done",
        prompt: "do it",
        output: "ok",
        conversation_id: null,
        started_at: at,
        finished_at: at,
      },
    ],
  });

  assert.equal(run.nodes?.[0]?.status, "done");
});

test("a run rejects a status the model does not know", () => {
  assert.throws(() =>
    v.parse(WorkflowRunSchema, {
      id: "r1",
      workflow_id: "w1",
      version: 1,
      status: "cancelled",
      input: "",
      output: null,
      created_at: at,
      finished_at: null,
    }),
  );
});

test("an automation parses with a schedule trigger", () => {
  const parsed = v.parse(AutomationSchema, {
    id: "a1",
    project_id: "p1",
    name: "nightly",
    trigger: { type: "schedule", cron: "0 3 * * *" },
    action: { type: "workflow", workflowId: "w1" },
    enabled: true,
    last_fired_at: null,
    created_at: at,
    updated_at: at,
  });

  assert.equal(parsed.trigger.type, "schedule");
});

test("an automation create rejects a webhook trigger without a type", () => {
  assert.throws(() =>
    v.parse(AutomationCreateSchema, {
      name: "hook",
      trigger: { token: "t" },
      action: { type: "task" },
    }),
  );
});

test("a passkey verification body keeps the WebAuthn response opaque", () => {
  const parsed = v.parse(PasskeyRegisterVerifySchema, {
    login: "someone",
    response: { id: "cred", response: { clientDataJSON: "x" } },
    wrapped: { wrappedDek: "d", iv: "i" },
    recovery: { wrappedDek: "d", iv: "i", salt: "s" },
  });

  assert.equal(parsed.login, "someone");
});

test("every route key matches its method and path", () => {
  for (const [key, contract] of Object.entries(ROUTES)) {
    assert.equal(key, `${contract.method} ${contract.path}`);
  }
});

test("the route table covers the documented surface", () => {
  assert.equal(Object.keys(ROUTES).length, 49);
});
