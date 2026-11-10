import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { ConversationIdSchema, ProjectIdSchema, isoTimestamp } from "@hns/core";
import type { IsoTimestamp } from "@hns/core";
import type { WorkflowGraph } from "@hns/core";
import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { openDatabase, readUserVersion } from "./db.ts";
import { migrate } from "./migrate.ts";
import { openStore, type Store } from "./store.ts";

function clock(start = "2026-01-01T00:00:00.000Z") {
  let at = Date.parse(start);
  return () => {
    const value = isoTimestamp(new Date(at).toISOString());
    at += 1000;
    return value;
  };
}

function counter() {
  let next = 0;
  return () => {
    next += 1;
    return "id-" + next;
  };
}

async function withStore(run: (store: Store) => void): Promise<void> {
  const store = openStore({ path: ":memory:", now: clock(), newId: counter() });
  try {
    run(store);
  } finally {
    store.close();
  }
}

const graph = (nodes: WorkflowGraph["nodes"]): WorkflowGraph => ({ nodes, edges: [] });

test("opening a store migrates and seeds the default project", () => {
  return withStore((store) => {
    const projects = store.projects.list();
    expect(projects.length).toBe(1);
    expect(projects[0]?.id).toBe("default");
    expect(projects[0]?.name).toBe("default");
  });
});

test("projects are created, renamed, listed and deleted", () => {
  return withStore((store) => {
    const created = store.projects.create("demo");
    expect(store.projects.get(created.id)?.name).toBe("demo");
    expect(store.projects.rename(created.id, "renamed")?.name).toBe("renamed");
    expect(store.projects.list().map((project) => project.name)).toStrictEqual([
      "default",
      "renamed",
    ]);
    expect(store.projects.delete(created.id)).toBe(true);
    expect(store.projects.get(created.id)).toBe(undefined);
    expect(store.projects.delete(created.id)).toBe(false);
  });
});

test("deleting a project cascades to tasks and conversations", () => {
  return withStore((store) => {
    const project = store.projects.create("cascade");
    store.tasks.create({ projectId: project.id, title: "task" });
    store.conversations.register({
      id: v.parse(ConversationIdSchema, "c1"),
      projectId: project.id,
      title: "chat",
    });
    expect(store.tasks.list(project.id).length).toBe(1);
    expect(store.conversations.list({ projectId: project.id }).length).toBe(1);
    store.projects.delete(project.id);
    expect(store.tasks.list(project.id).length).toBe(0);
    expect(store.conversations.list({ projectId: project.id }).length).toBe(0);
  });
});

test("tasks are created in a project, updated and deleted", () => {
  return withStore((store) => {
    const project = store.projects.ensureDefault();
    const created = store.tasks.create({ projectId: project.id, title: "one" });
    expect(created.status).toBe("todo");
    expect(store.tasks.get(created.id)?.title).toBe("one");
    const updated = store.tasks.update(created.id, { title: "two", status: "doing" });
    expect(updated?.title).toBe("two");
    expect(updated?.status).toBe("doing");
    expect(store.tasks.list(project.id).length).toBe(1);
    expect(store.tasks.delete(created.id)).toBe(true);
    expect(store.tasks.get(created.id)).toBe(undefined);
  });
});

test("a task in a missing project is refused by the foreign key", () => {
  return withStore((store) => {
    const missing = v.parse(ProjectIdSchema, "missing");
    expect(() => store.tasks.create({ projectId: missing, title: "nope" })).toThrow();
  });
});

test("conversations are registered, searched, archived and soft-deleted", () => {
  return withStore((store) => {
    const project = store.projects.ensureDefault();
    const other = store.projects.create("other");
    const first = v.parse(ConversationIdSchema, "c1");
    const second = v.parse(ConversationIdSchema, "c2");
    store.conversations.register({ id: first, projectId: project.id, title: "alpha chat" });
    store.conversations.register({ id: second, projectId: other.id, title: "beta chat" });
    expect(store.conversations.list().length).toBe(2);
    expect(
      store.conversations.list({ projectId: other.id }).map((conversation) => conversation.id),
    ).toStrictEqual([second]);
    expect(
      store.conversations.list({ q: "alpha" }).map((conversation) => conversation.id),
    ).toStrictEqual([first]);
    expect(store.conversations.list({ q: "%" }).length).toBe(0);
    expect(store.conversations.list({ q: "_" }).length).toBe(0);
    store.conversations.setArchived(second, true);
    expect(store.conversations.list().length).toBe(1);
    expect(store.conversations.list({ includeArchived: true }).length).toBe(2);
    const deleted = store.conversations.delete(first);
    expect(deleted?.deleted_at).not.toBe(null);
    expect(store.conversations.list({ includeArchived: true }).length).toBe(1);
    expect(store.conversations.get(first)?.deleted_at !== null).toBe(true);
    store.conversations.touch(second);
    expect(store.conversations.get(second)?.updated_at).not.toBe(null);
  });
});

test("events keep JSON detail, filter and return metrics", () => {
  return withStore((store) => {
    store.events.add({
      event: "http",
      status: 200,
      durationMs: 10,
      detail: { method: "GET", path: "/api/health" },
    });
    store.events.add({ event: "http", level: "warn", status: 500, durationMs: 30 });
    store.events.add({ event: "chat.submitted" });
    store.events.add({ event: "chat.settled" });
    store.events.add({ event: "tool.result", level: "warn" });
    store.events.add({ event: "agent.response" });
    // An http event without status or duration must not break the metric.
    store.events.add({ event: "http" });
    store.usage.add({ tokens: 7, cost: 0.5 });

    const listed = store.events.list({ limit: 10 });
    expect(listed.length).toBe(7);
    const withDetail = listed.find((event) => event.event === "http" && event.status === 200);
    expect(withDetail?.detail).toStrictEqual({ method: "GET", path: "/api/health" });
    expect(store.events.list({ level: "warn" }).length).toBe(2);

    const metrics = store.events.metrics();
    expect(metrics.http.total).toBe(3);
    expect(metrics.http.byStatus).toStrictEqual([
      { status: 200, count: 1 },
      { status: 500, count: 1 },
    ]);
    expect(metrics.http.p50ms).toBe(30);
    expect(metrics.http.p95ms).toBe(30);
    expect(metrics.chats["chat.submitted"]).toBe(1);
    expect(metrics.chats["chat.settled"]).toBe(1);
    expect(metrics.toolCalls).toBe(1);
    expect(metrics.toolErrors).toBe(1);
    expect(metrics.agentResponses).toBe(1);
    expect(metrics.errors).toBe(0);
    expect(metrics.tokensToday).toStrictEqual({ turns: 1, tokens: 7, cost: 0.5 });
  });
});

test("pruning events drops rows older than the cutoff", () => {
  const now = clock();
  const store = openStore({ path: ":memory:", now, newId: counter() });
  try {
    store.events.add({ event: "server.start" });
    expect(store.events.list().length).toBe(1);
    expect(store.events.prune(0)).toBe(1);
    expect(store.events.list().length).toBe(0);
  } finally {
    store.close();
  }
});

test("workflows keep versions, runs pin the version and nodes move through the states", () => {
  return withStore((store) => {
    const project = store.projects.ensureDefault();
    const workflow = store.workflows.create({
      projectId: project.id,
      name: "flow",
      graph: graph([
        { id: "plan", type: "agent", prompt: "Plan" },
        { id: "check", type: "human", prompt: "Check" },
      ]),
    });
    expect(workflow.version).toBe(1);
    const updated = store.workflows.update(
      workflow.id,
      graph([{ id: "solo", type: "agent", prompt: "Solo" }]),
    );
    expect(updated?.version).toBe(2);

    const run = store.workflows.createRun({ workflowId: workflow.id, input: "ship" });
    assert.equal(run?.version, 2);
    expect(store.workflows.getRunGraph(run.id)?.nodes.map((node) => node.id)).toStrictEqual([
      "solo",
    ]);
    store.workflows.update(workflow.id, graph([{ id: "later", type: "agent", prompt: "Later" }]));
    expect(store.workflows.getRunGraph(run.id)?.nodes.map((node) => node.id)).toStrictEqual([
      "solo",
    ]);
    expect(run?.nodes?.map((node) => node.status)).toStrictEqual(["pending"]);

    store.workflows.setRunStatus(run.id, "running");
    store.workflows.setNodeRunning(run.id, "solo", "Solo ship");
    expect(store.workflows.getRun(run.id)?.nodes?.[0]?.status).toBe("running");
    store.workflows.setNodeWaiting(run.id, "solo", "Approve");
    const completed = store.workflows.completeNode(run.id, "solo", "ok");
    expect(completed?.status).toBe("done");
    expect(store.workflows.completeNode(run.id, "solo", "again")).toBe(undefined);
    store.workflows.finishRun(run.id, "done", '{"solo":"ok"}');
    const finished = store.workflows.getRun(run.id);
    expect(finished?.status).toBe("done");
    expect(finished?.output).toBe('{"solo":"ok"}');
    expect(store.workflows.getRun(run.id)?.nodes?.[0]?.output).toBe("ok");
  });
});

test("resuming requeues running nodes and deletes cascade", () => {
  return withStore((store) => {
    const project = store.projects.ensureDefault();
    const workflow = store.workflows.create({
      projectId: project.id,
      name: "flow",
      graph: graph([{ id: "a", type: "agent", prompt: "A" }]),
    });
    const run = store.workflows.createRun({ workflowId: workflow.id, input: "x" });
    assert.ok(run !== undefined);
    store.workflows.setNodeRunning(run.id, "a", "A");
    store.workflows.setRunStatus(run.id, "running");
    const resumed = store.workflows.resumeRuns();
    expect(resumed.length).toBe(1);
    expect(store.workflows.getRun(run.id)?.nodes?.[0]?.status).toBe("pending");
    expect(store.workflows.delete(workflow.id)).toBe(true);
    expect(store.workflows.getRun(run.id)).toBe(undefined);
    expect(store.workflows.get(workflow.id)).toBe(undefined);
  });
});

test("a run whose graph cannot be inserted rolls back whole", () => {
  return withStore((store) => {
    const project = store.projects.ensureDefault();
    const workflow = store.workflows.create({
      projectId: project.id,
      name: "broken",
      graph: graph([
        { id: "same", type: "agent", prompt: "A" },
        { id: "same", type: "agent", prompt: "B" },
      ]),
    });
    expect(() => store.workflows.createRun({ workflowId: workflow.id, input: "x" })).toThrow();
    expect(store.workflows.listRuns().length).toBe(0);
  });
});

test("automations keep JSON triggers and firings", () => {
  return withStore((store) => {
    const project = store.projects.ensureDefault();
    const automation = store.automations.create({
      projectId: project.id,
      name: "hook",
      trigger: { type: "webhook" },
      action: { type: "task", title: "from hook" },
    });
    expect(automation.enabled).toBe(true);
    expect(automation.trigger.type).toBe("webhook");
    if (automation.trigger.type !== "webhook") throw new Error("webhook expected");
    const token = automation.trigger.token;
    if (token === undefined) throw new Error("webhook token missing");
    const byToken = store.automations.getByToken(token);
    expect(byToken?.id).toBe(automation.id);

    const disabled = store.automations.update(automation.id, { enabled: false, name: "renamed" });
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.name).toBe("renamed");
    expect(store.automations.getByToken(token)?.id).toBe(automation.id);

    store.automations.update(automation.id, { trigger: { type: "webhook", token: "new-token" } });
    expect(store.automations.getByToken("new-token")?.id).toBe(automation.id);
    expect(store.automations.getByToken(token)).toBe(undefined);

    const firing = store.automations.createFiring({
      automationId: automation.id,
      at: isoTimestamp("2026-01-01T00:00:00.000Z"),
      status: "running",
    });
    expect(store.automations.listFirings(automation.id).length).toBe(1);
    const settled = store.automations.updateFiring(firing.id, { status: "done", runId: "run-1" });
    expect(settled?.status).toBe("done");
    expect(settled?.run_id).toBe("run-1");
    store.automations.setLastFiredAt(automation.id, isoTimestamp("2026-01-01T00:01:00.000Z"));
    expect(store.automations.get(automation.id)?.last_fired_at).toBe("2026-01-01T00:01:00.000Z");
    expect(store.automations.delete(automation.id)).toBe(true);
    expect(store.automations.get(automation.id)).toBe(undefined);
    expect(store.automations.listFirings(automation.id).length).toBe(0);
  });
});

test("an automation rejects a non-ISO last_fired_at before writing", () => {
  return withStore((store) => {
    const project = store.projects.ensureDefault();
    const automation = store.automations.create({
      projectId: project.id,
      name: "hook",
      trigger: { type: "webhook" },
      action: { type: "task" },
    });
    // SAFETY: a JS caller can bypass the type; the setter must still refuse a non-ISO value.
    const hostileTime = "2026-01-01T00:01" as IsoTimestamp;
    expect(() => store.automations.setLastFiredAt(automation.id, hostileTime)).toThrow();
    expect(store.automations.get(automation.id)?.last_fired_at).toBe(null);
  });
});

test("a firing rejects a non-ISO at before writing", () => {
  return withStore((store) => {
    const project = store.projects.ensureDefault();
    const automation = store.automations.create({
      projectId: project.id,
      name: "hook",
      trigger: { type: "webhook" },
      action: { type: "task" },
    });
    // SAFETY: a JS caller can bypass the type; createFiring must still refuse a non-ISO value.
    const hostileTime = "2026-01-01T00:01" as IsoTimestamp;
    expect(() =>
      store.automations.createFiring({
        automationId: automation.id,
        at: hostileTime,
        status: "running",
      }),
    ).toThrow();
    expect(store.automations.listFirings(automation.id).length).toBe(0);
  });
});

test("usage is recorded and summed for the day", () => {
  return withStore((store) => {
    store.usage.add({ tokens: 3, cost: 0.25 });
    store.usage.add({ tokens: 4, cost: 0.5 });
    expect(store.usage.today()).toStrictEqual({ turns: 2, tokens: 7, cost: 0.75 });
    expect(store.usage.today("2026-01-02")).toStrictEqual({ turns: 0, tokens: 0, cost: 0 });
  });
});

test("reopening a file keeps the data and does not duplicate the default project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hns-store-"));
  const path = join(dir, "store.sqlite");
  try {
    const first = openStore({ path, now: clock(), newId: counter() });
    first.projects.create("kept");
    first.close();
    const second = openStore({ path, now: clock(), newId: counter() });
    try {
      expect(second.projects.list().map((project) => project.name)).toStrictEqual([
        "default",
        "kept",
      ]);
    } finally {
      second.close();
    }
    const db = openDatabase(path);
    try {
      expect(readUserVersion(db)).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt row fails loudly when read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hns-store-"));
  const path = join(dir, "store.sqlite");
  try {
    const seeded = openStore({ path, now: clock(), newId: counter() });
    seeded.close();
    const db = openDatabase(path);
    migrate(db);
    db.prepare(
      "INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "bad",
      "default",
      "bad",
      "unknown",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    db.close();
    const store = openStore({ path, now: clock(), newId: counter() });
    try {
      expect(() => store.tasks.get("bad")).toThrow();
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a non-ISO clock is refused before any write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hns-store-"));
  const path = join(dir, "store.sqlite");
  try {
    // SAFETY: a JS caller can bypass the type; the store must refuse a non-ISO clock.
    const hostileNow = () => "2026-01-01" as IsoTimestamp;
    expect(() => openStore({ path, now: hostileNow })).toThrow();
    const db = openDatabase(path);
    try {
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'")
        .get();
      expect(v.parse(v.object({ count: v.number() }), row).count).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a database newer than the store is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hns-store-"));
  const path = join(dir, "store.sqlite");
  try {
    const db = openDatabase(path);
    db.exec("PRAGMA user_version = 99");
    db.close();
    expect(() => openStore({ path })).toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("list limits are clamped", () => {
  return withStore((store) => {
    for (let index = 0; index < 3; index += 1) store.events.add({ event: "server.start" });
    expect(store.events.list({ limit: 0 }).length).toBe(1);
    expect(store.events.list({ limit: 10_000 }).length).toBe(3);
    const project = store.projects.ensureDefault();
    for (let index = 0; index < 3; index += 1) {
      store.conversations.register({
        id: v.parse(ConversationIdSchema, "c" + index),
        projectId: project.id,
        title: "chat",
      });
    }
    expect(store.conversations.list({ limit: 0 }).length).toBe(1);
    expect(store.conversations.list({ limit: 10_000 }).length).toBe(3);
  });
});
