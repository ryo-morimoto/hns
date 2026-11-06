import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { ConversationIdSchema, ProjectIdSchema, isoTimestamp } from "@hns/core";
import type { IsoTimestamp } from "@hns/core";
import type { WorkflowGraph } from "@hns/core";
import { test } from "vitest";
import { openDatabase, readUserVersion } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { openStore, type Store } from "../src/store.ts";

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
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.id, "default");
    assert.equal(projects[0]?.name, "default");
  });
});

test("projects are created, renamed, listed and deleted", () => {
  return withStore((store) => {
    const created = store.projects.create("demo");
    assert.equal(store.projects.get(created.id)?.name, "demo");
    assert.equal(store.projects.rename(created.id, "renamed")?.name, "renamed");
    assert.deepEqual(
      store.projects.list().map((project) => project.name),
      ["default", "renamed"],
    );
    assert.equal(store.projects.delete(created.id), true);
    assert.equal(store.projects.get(created.id), undefined);
    assert.equal(store.projects.delete(created.id), false);
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
    assert.equal(store.tasks.list(project.id).length, 1);
    assert.equal(store.conversations.list({ projectId: project.id }).length, 1);
    store.projects.delete(project.id);
    assert.equal(store.tasks.list(project.id).length, 0);
    assert.equal(store.conversations.list({ projectId: project.id }).length, 0);
  });
});

test("tasks are created in a project, updated and deleted", () => {
  return withStore((store) => {
    const project = store.projects.ensureDefault();
    const created = store.tasks.create({ projectId: project.id, title: "one" });
    assert.equal(created.status, "todo");
    assert.equal(store.tasks.get(created.id)?.title, "one");
    const updated = store.tasks.update(created.id, { title: "two", status: "doing" });
    assert.equal(updated?.title, "two");
    assert.equal(updated?.status, "doing");
    assert.equal(store.tasks.list(project.id).length, 1);
    assert.equal(store.tasks.delete(created.id), true);
    assert.equal(store.tasks.get(created.id), undefined);
  });
});

test("a task in a missing project is refused by the foreign key", () => {
  return withStore((store) => {
    const missing = v.parse(ProjectIdSchema, "missing");
    assert.throws(() => store.tasks.create({ projectId: missing, title: "nope" }));
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
    assert.equal(store.conversations.list().length, 2);
    assert.deepEqual(
      store.conversations.list({ projectId: other.id }).map((conversation) => conversation.id),
      [second],
    );
    assert.deepEqual(
      store.conversations.list({ q: "alpha" }).map((conversation) => conversation.id),
      [first],
    );
    assert.equal(store.conversations.list({ q: "%" }).length, 0);
    assert.equal(store.conversations.list({ q: "_" }).length, 0);
    store.conversations.setArchived(second, true);
    assert.equal(store.conversations.list().length, 1);
    assert.equal(store.conversations.list({ includeArchived: true }).length, 2);
    const deleted = store.conversations.delete(first);
    assert.notEqual(deleted?.deleted_at, null);
    assert.equal(store.conversations.list({ includeArchived: true }).length, 1);
    assert.equal(store.conversations.get(first)?.deleted_at !== null, true);
    store.conversations.touch(second);
    assert.notEqual(store.conversations.get(second)?.updated_at, null);
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
    assert.equal(listed.length, 7);
    const withDetail = listed.find((event) => event.event === "http" && event.status === 200);
    assert.deepEqual(withDetail?.detail, { method: "GET", path: "/api/health" });
    assert.equal(store.events.list({ level: "warn" }).length, 2);

    const metrics = store.events.metrics();
    assert.equal(metrics.http.total, 3);
    assert.deepEqual(metrics.http.byStatus, [
      { status: 200, count: 1 },
      { status: 500, count: 1 },
    ]);
    assert.equal(metrics.http.p50ms, 30);
    assert.equal(metrics.http.p95ms, 30);
    assert.equal(metrics.chats["chat.submitted"], 1);
    assert.equal(metrics.chats["chat.settled"], 1);
    assert.equal(metrics.toolCalls, 1);
    assert.equal(metrics.toolErrors, 1);
    assert.equal(metrics.agentResponses, 1);
    assert.equal(metrics.errors, 0);
    assert.deepEqual(metrics.tokensToday, { turns: 1, tokens: 7, cost: 0.5 });
  });
});

test("pruning events drops rows older than the cutoff", () => {
  const now = clock();
  const store = openStore({ path: ":memory:", now, newId: counter() });
  try {
    store.events.add({ event: "server.start" });
    assert.equal(store.events.list().length, 1);
    assert.equal(store.events.prune(0), 1);
    assert.equal(store.events.list().length, 0);
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
    assert.equal(workflow.version, 1);
    const updated = store.workflows.update(
      workflow.id,
      graph([{ id: "solo", type: "agent", prompt: "Solo" }]),
    );
    assert.equal(updated?.version, 2);

    const run = store.workflows.createRun({ workflowId: workflow.id, input: "ship" });
    assert.equal(run?.version, 2);
    assert.deepEqual(
      store.workflows.getRunGraph(run.id)?.nodes.map((node) => node.id),
      ["solo"],
    );
    store.workflows.update(workflow.id, graph([{ id: "later", type: "agent", prompt: "Later" }]));
    assert.deepEqual(
      store.workflows.getRunGraph(run.id)?.nodes.map((node) => node.id),
      ["solo"],
    );
    assert.deepEqual(
      run?.nodes?.map((node) => node.status),
      ["pending"],
    );

    store.workflows.setRunStatus(run.id, "running");
    store.workflows.setNodeRunning(run.id, "solo", "Solo ship");
    assert.equal(store.workflows.getRun(run.id)?.nodes?.[0]?.status, "running");
    store.workflows.setNodeWaiting(run.id, "solo", "Approve");
    const completed = store.workflows.completeNode(run.id, "solo", "ok");
    assert.equal(completed?.status, "done");
    assert.equal(store.workflows.completeNode(run.id, "solo", "again"), undefined);
    store.workflows.finishRun(run.id, "done", '{"solo":"ok"}');
    const finished = store.workflows.getRun(run.id);
    assert.equal(finished?.status, "done");
    assert.equal(finished?.output, '{"solo":"ok"}');
    assert.equal(store.workflows.getRun(run.id)?.nodes?.[0]?.output, "ok");
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
    assert.equal(resumed.length, 1);
    assert.equal(store.workflows.getRun(run.id)?.nodes?.[0]?.status, "pending");
    assert.equal(store.workflows.delete(workflow.id), true);
    assert.equal(store.workflows.getRun(run.id), undefined);
    assert.equal(store.workflows.get(workflow.id), undefined);
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
    assert.throws(() => store.workflows.createRun({ workflowId: workflow.id, input: "x" }));
    assert.equal(store.workflows.listRuns().length, 0);
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
    assert.equal(automation.enabled, true);
    assert.equal(automation.trigger.type, "webhook");
    if (automation.trigger.type !== "webhook") throw new Error("webhook expected");
    const token = automation.trigger.token;
    if (token === undefined) throw new Error("webhook token missing");
    const byToken = store.automations.getByToken(token);
    assert.equal(byToken?.id, automation.id);

    const disabled = store.automations.update(automation.id, { enabled: false, name: "renamed" });
    assert.equal(disabled?.enabled, false);
    assert.equal(disabled?.name, "renamed");
    assert.equal(store.automations.getByToken(token)?.id, automation.id);

    store.automations.update(automation.id, { trigger: { type: "webhook", token: "new-token" } });
    assert.equal(store.automations.getByToken("new-token")?.id, automation.id);
    assert.equal(store.automations.getByToken(token), undefined);

    const firing = store.automations.createFiring({
      automationId: automation.id,
      at: isoTimestamp("2026-01-01T00:00:00.000Z"),
      status: "running",
    });
    assert.equal(store.automations.listFirings(automation.id).length, 1);
    const settled = store.automations.updateFiring(firing.id, { status: "done", runId: "run-1" });
    assert.equal(settled?.status, "done");
    assert.equal(settled?.run_id, "run-1");
    store.automations.setLastFiredAt(automation.id, isoTimestamp("2026-01-01T00:01:00.000Z"));
    assert.equal(store.automations.get(automation.id)?.last_fired_at, "2026-01-01T00:01:00.000Z");
    assert.equal(store.automations.delete(automation.id), true);
    assert.equal(store.automations.get(automation.id), undefined);
    assert.equal(store.automations.listFirings(automation.id).length, 0);
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
    assert.throws(() => store.automations.setLastFiredAt(automation.id, hostileTime));
    assert.equal(store.automations.get(automation.id)?.last_fired_at, null);
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
    assert.throws(() =>
      store.automations.createFiring({
        automationId: automation.id,
        at: hostileTime,
        status: "running",
      }),
    );
    assert.equal(store.automations.listFirings(automation.id).length, 0);
  });
});

test("usage is recorded and summed for the day", () => {
  return withStore((store) => {
    store.usage.add({ tokens: 3, cost: 0.25 });
    store.usage.add({ tokens: 4, cost: 0.5 });
    assert.deepEqual(store.usage.today(), { turns: 2, tokens: 7, cost: 0.75 });
    assert.deepEqual(store.usage.today("2026-01-02"), { turns: 0, tokens: 0, cost: 0 });
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
      assert.deepEqual(
        second.projects.list().map((project) => project.name),
        ["default", "kept"],
      );
    } finally {
      second.close();
    }
    const db = openDatabase(path);
    try {
      assert.equal(readUserVersion(db), 1);
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
      assert.throws(() => store.tasks.get("bad"));
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
    assert.throws(() => openStore({ path, now: hostileNow }));
    const db = openDatabase(path);
    try {
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'")
        .get();
      assert.equal(v.parse(v.object({ count: v.number() }), row).count, 0);
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
    assert.throws(() => openStore({ path }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("list limits are clamped", () => {
  return withStore((store) => {
    for (let index = 0; index < 3; index += 1) store.events.add({ event: "server.start" });
    assert.equal(store.events.list({ limit: 0 }).length, 1);
    assert.equal(store.events.list({ limit: 10_000 }).length, 3);
    const project = store.projects.ensureDefault();
    for (let index = 0; index < 3; index += 1) {
      store.conversations.register({
        id: v.parse(ConversationIdSchema, "c" + index),
        projectId: project.id,
        title: "chat",
      });
    }
    assert.equal(store.conversations.list({ limit: 0 }).length, 1);
    assert.equal(store.conversations.list({ limit: 10_000 }).length, 3);
  });
});
