import * as v from "valibot";
import { ConversationIdSchema, ProjectIdSchema } from "@hns/core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createD1Harness, type D1Harness } from "../harness.ts";

let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

test("projects are created, renamed, listed and deleted", async () => {
  await harness.withStore(async (store) => {
    const created = await store.projects.create("demo", "projects/demo");
    expect((await store.projects.get(created.id))?.name).toBe("demo");
    expect(created.workspace_root).toBe("projects/demo");
    expect(created.agent_cwd).toBe("projects/demo");
    expect(created.egress).toBe("inherit");
    expect((await store.projects.rename(created.id, "renamed"))?.name).toBe("renamed");
    expect((await store.projects.list()).map((project) => project.name)).toStrictEqual([
      "default",
      "renamed",
    ]);
    expect(await store.projects.delete(created.id)).toBe(true);
    expect(await store.projects.get(created.id)).toBe(undefined);
    expect(await store.projects.delete(created.id)).toBe(false);
  });
});

// Catches: the default project pointing anywhere but the machine ROOT it already used.
test("the default project keeps the machine ROOT", async () => {
  await harness.withStore(async (store) => {
    const project = await store.projects.ensureDefault();
    expect(project.id).toBe("default");
    expect(project.workspace_root).toBe("");
    expect(project.agent_cwd).toBe("");
    expect(project.egress).toBe("inherit");
  });
});

// Catches: two projects sharing a root, or one project's root leaking into another's row.
test("projects keep separate roots", async () => {
  await harness.withStore(async (store) => {
    const a = await store.projects.create("a", "projects/a");
    const b = await store.projects.create("b", "projects/b");
    expect((await store.projects.get(a.id))?.workspace_root).toBe("projects/a");
    expect((await store.projects.get(b.id))?.workspace_root).toBe("projects/b");
    const roots = (await store.projects.list()).map((project) => project.workspace_root);
    expect(roots).toStrictEqual(["", "projects/a", "projects/b"]);
  });
});

// Catches: a non-canonical root stored by a caller that skipped the mutation's validation.
test.each(["", "/abs", "../x", "a//b", ".hns/x", "a\\b"])(
  "creating a project with the root %j is refused and writes nothing",
  async (root) => {
    await harness.withStore(async (store) => {
      await expect(store.projects.create("bad", root)).rejects.toThrow();
      expect((await store.projects.list()).map((project) => project.name)).toStrictEqual([
        "default",
      ]);
    });
  },
);

test("deleting a project cascades to tasks and conversations", async () => {
  await harness.withStore(async (store) => {
    const project = await store.projects.create("cascade", "projects/cascade");
    await store.tasks.create({ projectId: project.id, title: "task" });
    await store.conversations.register({
      id: v.parse(ConversationIdSchema, "c1"),
      projectId: project.id,
      title: "chat",
    });
    expect((await store.tasks.list(project.id)).length).toBe(1);
    expect((await store.conversations.page({ projectId: project.id })).items.length).toBe(1);
    await store.projects.delete(project.id);
    expect((await store.tasks.list(project.id)).length).toBe(0);
    expect((await store.conversations.page({ projectId: project.id })).items.length).toBe(0);
  });
});

test("tasks are created in a project, updated and deleted", async () => {
  await harness.withStore(async (store) => {
    const project = await store.projects.ensureDefault();
    const created = await store.tasks.create({ projectId: project.id, title: "one" });
    expect(created.status).toBe("todo");
    expect((await store.tasks.get(created.id))?.title).toBe("one");
    const updated = await store.tasks.update(created.id, { title: "two", status: "doing" });
    expect(updated?.title).toBe("two");
    expect(updated?.status).toBe("doing");
    expect((await store.tasks.list(project.id)).length).toBe(1);
    expect(await store.tasks.delete(created.id)).toBe(true);
    expect(await store.tasks.get(created.id)).toBe(undefined);
  });
});

test("a task in a missing project is refused by the foreign key", async () => {
  await harness.withStore(async (store) => {
    const missing = v.parse(ProjectIdSchema, "missing");
    await expect(store.tasks.create({ projectId: missing, title: "nope" })).rejects.toThrow();
  });
});
