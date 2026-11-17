import { afterAll, beforeAll, expect, test } from "vitest";
import {
  openConversationIndex,
  type ConversationIndexRow,
} from "../../../src/conversation-index/index.ts";
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
