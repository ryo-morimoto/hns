import type { ConversationId, EntryId, SubmissionId } from "@earendil-works/pi-durable";
import type { AgentSession, IndexMark, PendingIndexEntry } from "@hns/agent/session";
import type { Conversation } from "@hns/core";
import { ConversationIdSchema, parseObsLog, ProjectIdSchema } from "@hns/core";
import type { D1Binding } from "@hns/store";
import { openConversationIndex } from "@hns/store/conversation-index";
import * as v from "valibot";
import { expect, test, vi } from "vitest";
import { openFakeD1, type FakeD1 } from "../../test/support/d1.ts";
import { openSqliteState } from "../../test/support/sqlite.ts";
import { Session } from "./session.ts";

const AT = "2026-01-01T00:00:00.000Z";

function conversation(id: string, title = "chat", updated: string = AT): Conversation {
  return {
    id: v.parse(ConversationIdSchema, id),
    project_id: v.parse(ProjectIdSchema, "default"),
    title,
    created_at: AT,
    updated_at: updated,
    archived: false,
    deleted_at: null,
  };
}

/** A settled answer for the routes that succeed. */
function answer(): Awaited<ReturnType<AgentSession["send"]>> {
  // SAFETY: pi-durable allocates these ids as positive integers and the RPC reads only the
  // settlement fields; the brands are compile-time only.
  const settlement = {
    id: 7 as SubmissionId,
    conversationId: 2 as ConversationId,
    type: "input",
    status: "done",
    entry: 3 as EntryId,
    answer: 4 as EntryId,
  } as const;
  return { settlement, text: "answered" };
}

/** An object state over real SQLite with the alarm methods the Session arms. */
function objectState() {
  const opened = openSqliteState();
  const storage = {
    ...opened.state.storage,
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
  };
  return {
    state: {
      storage,
      blockConcurrencyWhile: opened.state.blockConcurrencyWhile,
      abort: () => undefined,
    },
    close: () => {
      opened.close();
    },
  };
}

/** A Session runtime whose index is scripted: the pending rows and the rebuild rows. */
function indexedSession(options: { rebuild?: readonly Conversation[] } = {}) {
  const marks: IndexMark[] = [];
  let pending: PendingIndexEntry[] = [];
  const session: AgentSession = {
    closed: new Promise(() => undefined),
    createConversation: async () => conversation("1"),
    listConversations: async () => [conversation("1")],
    getConversation: async () => conversation("1"),
    send: async () => answer(),
    transcript: async () => [],
    watchConversation: async () => {
      throw new Error("not used");
    },
    abort: async () => false,
    pendingIndex: async (limit?: number) => {
      const batch = limit === undefined ? pending.length : Math.min(limit, pending.length);
      const entries = pending.slice(0, batch);
      return { entries, remaining: pending.length - batch, legacy: 0 };
    },
    markIndexed: async (entries) => {
      marks.push(...entries);
      pending = pending.filter(
        (entry) => !entries.some((mark) => mark.id === entry.conversation.id),
      );
    },
    indexRows: async () => options.rebuild ?? [conversation("1")],
    wake: () => ({ active: false }),
    resume: () => undefined,
    close: async () => undefined,
  };
  return {
    session,
    marks,
    markDirty(id: string, version: string = AT): void {
      pending.push({ conversation: conversation(id), version });
    },
  };
}

/** A binding that can refuse the index writes, and the switch that does it. */
interface FlakyBinding {
  readonly db: D1Binding;
  fail(value: boolean): void;
}

/** A binding whose batched writes fail, to prove the turn survives a D1 outage. */
function flaky(d1: FakeD1): FlakyBinding {
  let failing = false;
  return {
    db: {
      prepare: (sql) => d1.db.prepare(sql),
      // The index upsert is the only batch after the object is open; the cost ledger's batch
      // failures are logged and never fail the turn.
      batch: (statements) =>
        failing ? Promise.reject(new Error("d1 is down")) : d1.db.batch(statements),
    },
    fail: (value) => {
      failing = value;
    },
  };
}


function send(id: string): Request {
  return new Request("https://session/rpc/conversations/" + id + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "req-1" },
    body: JSON.stringify({ text: "hi" }),
  });
}

function list(): Request {
  return new Request("https://session/rpc/conversations", {
    headers: { "x-request-id": "req-2" },
  });
}

function reindex(): Request {
  return new Request("https://session/rpc/reindex", {
    method: "POST",
    headers: { "x-request-id": "req-3" },
  });
}

/**
 * Seed the project the index rows reference.
 *
 * @remarks
 * A deployment seeds it from the edge (`openStore` runs `ensureDefault`); a Session object
 * opened without the edge has to be given it here, or the index row's foreign key fails.
 */
function seedProject(d1: FakeD1): void {
  d1.exec(
    "INSERT OR IGNORE INTO projects (id, name, created_at, workspace_root, egress) " +
      "VALUES ('default', 'default', '" +
      AT +
      "', '', 'inherit')",
  );
}

// Catches: a turn whose conversation never reaches the index, so the list cannot show it.
test("a successful turn writes its conversation into the D1 index", async () => {
  const d1 = openFakeD1();
  const state = objectState();
  const fake = indexedSession();
  const session = new Session(state.state, { DB: d1.db }, async () => fake.session);
  try {
    await session.fetch(list());
    seedProject(d1);
    fake.markDirty("1");
    const response = await session.fetch(send("1"));
    expect(response.status).toBe(200);
    expect(fake.marks).toStrictEqual([{ id: "1", version: AT }]);
    const row = await d1.db
      .prepare("SELECT title, indexed_at FROM conversations WHERE project_id = ? AND id = ?")
      .bind("default", "1")
      .first();
    expect(row).toMatchObject({ title: "chat" });
    const index = openConversationIndex(d1.db);
    expect(await index.state("default")).toStrictEqual({
      pending: 0,
      lastSyncedAt: expect.any(String),
      lastErrorCode: null,
      lastErrorAt: null,
    });
  } finally {
    state.close();
    d1.close();
  }
});

// Catches: a D1 outage failing the chat, or the dirty row being cleared without a write.
test("a D1 failure leaves the turn successful, the row dirty, and the backlog recorded", async () => {
  const d1 = openFakeD1();
  const flakyDb = flaky(d1);
  const state = objectState();
  const fake = indexedSession();
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const session = new Session(state.state, { DB: flakyDb.db }, async () => fake.session);
  try {
    await session.fetch(list());
    seedProject(d1);
    fake.markDirty("1");

    flakyDb.fail(true);
    const response = await session.fetch(send("1"));
    expect(response.status).toBe(200);
    expect(fake.marks).toStrictEqual([]);
    const index = openConversationIndex(d1.db);
    expect(await index.state("default")).toMatchObject({
      pending: 1,
      lastErrorCode: "d1_write_failed",
      lastSyncedAt: expect.any(String),
    });
    // The drain's line is the log entry the index builds, not free JSON: the shape of the log is
    // one type across the worker, the object, and the index.
    const lines = errors.mock.calls.map((call) => String(call[0]));
    const line = lines.find((text) => text.includes("index.drain.failed"));
    expect(line).toBeDefined();
    expect(parseObsLog(JSON.parse(line ?? "null"))).toMatchObject({
      v: 1,
      level: "warn",
      event: "index.drain.failed",
      hop: "do",
      // No `pending` count: OBS_DETAIL_KEYS has no key for it, so the line keeps the code only.
      detail: { code: "d1_write_failed" },
    });
    expect(line).not.toContain("hi");
    expect(line).not.toContain("answered");

    // The next request is the retry: the row is written and the mark cleared.
    flakyDb.fail(false);
    const retried = await session.fetch(list());
    expect(retried.status).toBe(200);
    expect(fake.marks).toStrictEqual([{ id: "1", version: AT }]);
    expect(await index.state("default")).toMatchObject({
      pending: 0,
      lastErrorCode: null,
    });
  } finally {
    errors.mockRestore();
    state.close();
    d1.close();
  }
});

// Catches: a rebuild that trusts a corrupted row, or leaves rows the object no longer has.
test("a rebuild repairs the index from the object's metadata", async () => {
  const d1 = openFakeD1();
  const state = objectState();
  const truth = conversation("1", "truth");
  const fake = indexedSession({ rebuild: [truth] });
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const session = new Session(state.state, { DB: d1.db }, async () => fake.session);
  try {
    await session.fetch(list());
    seedProject(d1);
    const index = openConversationIndex(d1.db);
    await index.upsert([
      {
        id: "1",
        projectId: "default",
        title: "corrupt",
        createdAt: AT,
        updatedAt: "2030-01-01T00:00:00.000Z",
        archived: false,
        deletedAt: null,
        indexedAt: AT,
      },
      {
        id: "9",
        projectId: "default",
        title: "stale",
        createdAt: AT,
        updatedAt: AT,
        archived: false,
        deletedAt: null,
        indexedAt: AT,
      },
    ]);
    const response = await session.fetch(reindex());
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ ok: true, indexed: 1, removed: 1 });
    const rows = await d1.db.prepare("SELECT id, title FROM conversations").all();
    expect(rows.results).toStrictEqual([{ id: "1", title: "truth" }]);
    expect(fake.marks).toStrictEqual([{ id: "1", version: truth.updated_at }]);
  } finally {
    errors.mockRestore();
    state.close();
    d1.close();
  }
});

// Catches: a rebuild answered as a success when the object could not be read.
test("a rebuild that cannot read the object is a 500, not an empty index", async () => {
  const d1 = openFakeD1();
  const state = objectState();
  const fake = indexedSession();
  fake.session.indexRows = async () => {
    throw new Error("storage is gone");
  };
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const session = new Session(state.state, { DB: d1.db }, async () => fake.session);
  try {
    const response = await session.fetch(reindex());
    expect(response.status).toBe(500);
  } finally {
    errors.mockRestore();
    state.close();
    d1.close();
  }
});

// Catches: a deployment without the control database failing every turn.
test("a Session without the database still serves conversations", async () => {
  const state = objectState();
  const fake = indexedSession();
  const session = new Session(state.state, {}, async () => fake.session);
  try {
    fake.markDirty("1");
    const response = await session.fetch(send("1"));
    expect(response.status).toBe(200);
    expect(fake.marks).toStrictEqual([]);
    const reindexResponse = await session.fetch(reindex());
    expect(reindexResponse.status).toBe(503);
  } finally {
    state.close();
  }
});
