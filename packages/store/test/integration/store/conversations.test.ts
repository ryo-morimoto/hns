import * as v from "valibot";
import { ConversationIdSchema } from "@hns/core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createD1Harness, type D1Harness } from "../harness.ts";

let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

test("conversations are registered, searched, archived and soft-deleted", async () => {
  await harness.withStore(async (store) => {
    const project = await store.projects.ensureDefault();
    const other = await store.projects.create("other", "projects/other");
    const first = v.parse(ConversationIdSchema, "c1");
    const second = v.parse(ConversationIdSchema, "c2");
    await store.conversations.register({
      id: first,
      projectId: project.id,
      title: "alpha chat",
    });
    await store.conversations.register({ id: second, projectId: other.id, title: "beta chat" });
    expect((await store.conversations.list()).length).toBe(2);
    expect(
      (await store.conversations.list({ projectId: other.id })).map(
        (conversation) => conversation.id,
      ),
    ).toStrictEqual([second]);
    expect(
      (await store.conversations.list({ q: "alpha" })).map((conversation) => conversation.id),
    ).toStrictEqual([first]);
    expect((await store.conversations.list({ q: "%" })).length).toBe(0);
    expect((await store.conversations.list({ q: "_" })).length).toBe(0);
    await store.conversations.setArchived(second, true);
    expect((await store.conversations.list()).length).toBe(1);
    expect((await store.conversations.list({ includeArchived: true })).length).toBe(2);
    const deleted = await store.conversations.delete(first);
    expect(deleted?.deleted_at).not.toBe(null);
    expect((await store.conversations.list({ includeArchived: true })).length).toBe(1);
    expect((await store.conversations.get(first))?.deleted_at !== null).toBe(true);
    await store.conversations.touch(second);
    expect((await store.conversations.get(second))?.updated_at).not.toBe(null);
  });
});

test("conversation list limits are clamped", async () => {
  await harness.withStore(async (store) => {
    const project = await store.projects.ensureDefault();
    for (let index = 0; index < 3; index += 1) {
      await store.conversations.register({
        id: v.parse(ConversationIdSchema, "c" + index),
        projectId: project.id,
        title: "chat",
      });
    }
    expect((await store.conversations.list({ limit: 0 })).length).toBe(1);
    expect((await store.conversations.list({ limit: 10_000 })).length).toBe(3);
  });
});
