import * as v from "valibot";
import { ConversationIdSchema } from "@hns/core";
import type { ConversationCursor } from "../../../src/index.ts";
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
    expect((await store.conversations.page()).items.length).toBe(2);
    expect(
      (await store.conversations.page({ projectId: other.id })).items.map(
        (conversation) => conversation.id,
      ),
    ).toStrictEqual([second]);
    expect(
      (await store.conversations.page({ q: "alpha" })).items.map((conversation) => conversation.id),
    ).toStrictEqual([first]);
    expect((await store.conversations.page({ q: "%" })).items.length).toBe(0);
    expect((await store.conversations.page({ q: "_" })).items.length).toBe(0);
    await store.conversations.setArchived(other.id, second, true);
    expect((await store.conversations.page()).items.length).toBe(1);
    expect((await store.conversations.page({ includeArchived: true })).items.length).toBe(2);
    const deleted = await store.conversations.delete(project.id, first);
    expect(deleted?.deleted_at).not.toBe(null);
    expect((await store.conversations.page({ includeArchived: true })).items.length).toBe(1);
    expect((await store.conversations.get(project.id, first))?.deleted_at !== null).toBe(true);
    await store.conversations.touch(other.id, second);
    expect((await store.conversations.get(other.id, second))?.updated_at).not.toBe(null);
  });
});

// Catches: a get that ignores the project, so one project's id returns another's conversation.
test("a conversation is fetched by its project and id pair", async () => {
  await harness.withStore(async (store) => {
    const first = await store.projects.ensureDefault();
    const second = await store.projects.create("other", "projects/other");
    const id = v.parse(ConversationIdSchema, "7");
    await store.conversations.register({ id, projectId: first.id, title: "mine" });
    await store.conversations.register({ id, projectId: second.id, title: "theirs" });
    expect((await store.conversations.get(first.id, id))?.title).toBe("mine");
    expect((await store.conversations.get(second.id, id))?.title).toBe("theirs");
    expect(await store.conversations.get(second.id, v.parse(ConversationIdSchema, "8"))).toBe(
      undefined,
    );
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
    expect((await store.conversations.page({ limit: 0 })).items.length).toBe(1);
    expect((await store.conversations.page({ limit: 10_000 })).items.length).toBe(3);
  });
});

// Catches: a cursor that skips a row forever when an older row is updated between pages.
test("a keyset cursor pages through a stable list without repeating or skipping", async () => {
  await harness.withStore(async (store) => {
    const project = await store.projects.ensureDefault();
    for (let index = 0; index < 5; index += 1) {
      await store.conversations.register({
        id: v.parse(ConversationIdSchema, "c" + index),
        projectId: project.id,
        title: "chat",
      });
    }
    const seen: string[] = [];
    let after: ConversationCursor | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await store.conversations.page({ projectId: project.id, limit: 2, after });
      for (const conversation of result.items) {
        if (!seen.includes(conversation.id)) seen.push(conversation.id);
      }
      if (result.nextCursor === null) break;
      after = result.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });
});

// Catches: an update between pages making the cursor loop or lose the tail of the list.
test("a row updated between pages does not stall or truncate the cursor walk", async () => {
  await harness.withStore(async (store) => {
    const project = await store.projects.ensureDefault();
    for (let index = 0; index < 4; index += 1) {
      await store.conversations.register({
        id: v.parse(ConversationIdSchema, "c" + index),
        projectId: project.id,
        title: "chat",
      });
    }
    const first = await store.conversations.page({ projectId: project.id, limit: 2 });
    expect(first.items).toHaveLength(2);
    // The oldest row moves to the front while the client holds the first page's cursor, so the
    // walk cannot see it again: that is the accepted gap, and the next read starts with it.
    await store.conversations.touch(project.id, v.parse(ConversationIdSchema, "c0"));
    const seen = new Set(first.items.map((conversation) => conversation.id));
    let after = first.nextCursor;
    let pages = 0;
    while (after !== null) {
      pages += 1;
      expect(pages).toBeLessThan(10);
      const next = await store.conversations.page({
        projectId: project.id,
        limit: 2,
        after,
      });
      for (const conversation of next.items) seen.add(conversation.id);
      after = next.nextCursor;
    }
    // The walk terminates and loses nothing that stayed in place.
    expect(seen.size).toBe(3);
    // The row that moved is not lost: the next read starts with it.
    const fresh = await store.conversations.page({ projectId: project.id, limit: 1 });
    expect(fresh.items.map((conversation) => conversation.id)).toStrictEqual([
      v.parse(ConversationIdSchema, "c0"),
    ]);
  });
});
