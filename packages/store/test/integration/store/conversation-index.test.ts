import { afterAll, beforeAll, expect, test } from "vitest";
import {
  openConversationIndex,
  type ConversationIndexRow,
} from "../../../src/conversation-index/index.ts";
import { ConversationIdSchema } from "@hns/core";
import * as v from "valibot";
import { createD1Harness, type D1Harness } from "../harness.ts";

let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

function row(overrides: Partial<ConversationIndexRow> = {}): ConversationIndexRow {
  return {
    id: "1",
    projectId: "default",
    title: "chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archived: false,
    deletedAt: null,
    indexedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

// Catches: a stale resend rolling a newer row back, which would make the list lose an update.
test("an older row never overwrites a newer one", async () => {
  await harness.withStore(async () => {
    const index = openConversationIndex(harness.db);
    await index.upsert([row({ title: "new", updatedAt: "2026-01-02T00:00:00.000Z" })]);
    await index.upsert([row({ title: "old", updatedAt: "2026-01-01T00:00:00.000Z" })]);
    const stored = await harness.db
      .prepare("SELECT title, updated_at FROM conversations WHERE project_id = ? AND id = ?")
      .bind("default", "1")
      .first();
    expect(stored).toStrictEqual({ title: "new", updated_at: "2026-01-02T00:00:00.000Z" });
  });
});

// Catches: a rebuild that cannot repair a row whose stored timestamp is ahead of the object.
test("a rebuild replaces the stored row whatever its timestamp says", async () => {
  await harness.withStore(async () => {
    const index = openConversationIndex(harness.db);
    await index.upsert([row({ title: "corrupt", updatedAt: "2030-01-01T00:00:00.000Z" })]);
    await index.replaceAll("default", [row({ title: "truth" })]);
    const stored = await harness.db
      .prepare("SELECT title, updated_at FROM conversations WHERE project_id = ? AND id = ?")
      .bind("default", "1")
      .first();
    expect(stored).toStrictEqual({ title: "truth", updated_at: "2026-01-01T00:00:00.000Z" });
  });
});

// Catches: a rebuild leaving rows the object no longer knows, or deleting another project's rows.
test("a rebuild removes rows the project no longer has and leaves other projects alone", async () => {
  await harness.withStore(async (store) => {
    const other = await store.projects.create("other", "projects/other");
    const index = openConversationIndex(harness.db);
    await index.upsert([row({ id: "1" }), row({ id: "2" }), row({ id: "3", projectId: other.id })]);
    const result = await index.replaceAll("default", [row({ id: "1" })]);
    expect(result).toStrictEqual({ indexed: 1, removed: 1 });
    const ids = await harness.db
      .prepare("SELECT id, project_id FROM conversations ORDER BY project_id, id")
      .all();
    expect(ids.results).toStrictEqual([
      { id: "1", project_id: "default" },
      { id: "3", project_id: other.id },
    ]);
  });
});

// Catches: a delete that ignores the project and removes another project's conversation.
test("removing ids is scoped to one project", async () => {
  await harness.withStore(async (store) => {
    const other = await store.projects.create("other", "projects/other");
    const index = openConversationIndex(harness.db);
    await index.upsert([row({ id: "1" }), row({ id: "1", projectId: other.id })]);
    expect(await index.remove("default", ["1", "missing"])).toBe(1);
    const left = await harness.db.prepare("SELECT project_id FROM conversations").all();
    expect(left.results).toStrictEqual([{ project_id: other.id }]);
  });
});

// Catches: an index state that cannot tell "no drain yet" from "in sync", or one that never clears.
test("the index state reads zeroed when absent and round-trips a transition", async () => {
  await harness.withStore(async (store) => {
    const index = openConversationIndex(harness.db);
    expect(await store.indexState.read("default")).toStrictEqual({
      pending: 0,
      lastSyncedAt: null,
      lastErrorCode: null,
      lastErrorAt: null,
    });
    await index.writeState(
      "default",
      {
        pending: 2,
        lastSyncedAt: null,
        lastErrorCode: "d1_write_failed",
        lastErrorAt: "2026-01-01T00:00:00.000Z",
      },
      "2026-01-01T00:00:01.000Z",
    );
    expect(await store.indexState.read("default")).toStrictEqual({
      pending: 2,
      lastSyncedAt: null,
      lastErrorCode: "d1_write_failed",
      lastErrorAt: "2026-01-01T00:00:00.000Z",
    });
    await index.writeState(
      "default",
      {
        pending: 0,
        lastSyncedAt: "2026-01-01T00:00:02.000Z",
        lastErrorCode: null,
        lastErrorAt: null,
      },
      "2026-01-01T00:00:03.000Z",
    );
    expect((await store.indexState.read("default")).pending).toBe(0);
  });
});

/**
 * The three columns a person owns, read straight from D1.
 *
 * @returns The row's title, archive flag, and tombstone.
 */
async function personOwned(): Promise<{
  readonly title: string;
  readonly archived: number;
  readonly deleted_at: string | null;
}> {
  return v.parse(
    v.object({ title: v.string(), archived: v.number(), deleted_at: v.nullable(v.string()) }),
    await harness.db
      .prepare("SELECT title, archived, deleted_at FROM conversations WHERE id = ?")
      .bind("1")
      .first(),
  );
}

// Catches: the object's drain or rebuild overwriting a person's title, archive flag, or tombstone
// — the defect that made a rename disappear, an archive reopen, and a delete resurrect on the next
// turn (0271n). The rule is the writer's, so it is proved on the writer.
test("an object write keeps a person's title, archive flag and tombstone (drain and rebuild)", async () => {
  await harness.withStore(async (store) => {
    const index = openConversationIndex(harness.db);
    await index.upsert([row({ title: "object title" })]);
    const id = v.parse(ConversationIdSchema, "1");
    const project = await store.projects.ensureDefault();
    await store.conversations.rename(project.id, id, "person title");
    await store.conversations.setArchived(project.id, id, true);
    // A drain: a newer object row, which would normally win on the monotonic upsert.
    await index.upsert([row({ title: "object title", updatedAt: "2026-01-05T00:00:00.000Z" })]);
    expect(await personOwned()).toStrictEqual({
      title: "person title",
      archived: 1,
      deleted_at: null,
    });
    // A rebuild: the object saying what it holds is still not the person's answer.
    await index.replaceAll("default", [row({ title: "object title" })]);
    expect(await personOwned()).toStrictEqual({
      title: "person title",
      archived: 1,
      deleted_at: null,
    });
    // A delete stays a tombstone through the same writes.
    await store.conversations.softDelete(project.id, id);
    const buried = (await personOwned()).deleted_at;
    expect(buried).not.toBe(null);
    await index.upsert([row({ deletedAt: null, updatedAt: "2026-01-06T00:00:00.000Z" })]);
    await index.replaceAll("default", [row({ deletedAt: null })]);
    expect((await personOwned()).deleted_at).toBe(buried);
    // The object still owns activity: the drain moved the row's updated_at.
    const activity = v.parse(
      v.object({ updated_at: v.string() }),
      await harness.db
        .prepare("SELECT updated_at FROM conversations WHERE id = ?")
        .bind("1")
        .first(),
    );
    expect(activity.updated_at).toBe("2026-01-01T00:00:00.000Z");
  });
});
