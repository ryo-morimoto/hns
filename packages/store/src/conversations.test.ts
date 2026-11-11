import * as v from "valibot";
import { ConversationIdSchema } from "@hns/core";
import { expect, test } from "vitest";
import { withStore } from "../test/support.ts";

test("conversations are registered, searched, archived and soft-deleted", () => {
  withStore((store) => {
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

test("conversation list limits are clamped", () => {
  withStore((store) => {
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
