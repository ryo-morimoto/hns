import * as v from "valibot";
import { ConversationIdSchema, ProjectIdSchema } from "@hns/core";
import { expect, test } from "vitest";
import { withStore } from "../test/support.ts";

test("projects are created, renamed, listed and deleted", () => {
  withStore((store) => {
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
  withStore((store) => {
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
  withStore((store) => {
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
  withStore((store) => {
    const missing = v.parse(ProjectIdSchema, "missing");
    expect(() => store.tasks.create({ projectId: missing, title: "nope" })).toThrow();
  });
});
