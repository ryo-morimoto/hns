import { operationId, type MutationResult } from "@hns/core";
import {
  JOURNAL_INLINE_BODY_MAX_BYTES,
  JOURNAL_MAX_ROWS_PER_MUTATION,
  journalBodyKey,
} from "@hns/store";
import assert from "node:assert/strict";
import { expect, test } from "vitest";
import * as v from "valibot";
import { openSqliteState, type TestSqliteState } from "../../test/support/sqlite.ts";
import {
  JOURNAL_READ_MAX_LIMIT,
  Journal,
  JournalWatermarkError,
  type JournalBucket,
} from "./journal.ts";
import { Workspace } from "./workspace.ts";

/**
 * A bucket that records what it stored.
 *
 * @remarks
 * R2 is the only reason a journal body leaves its row, so the test needs the put count and the
 * key, not a server. `refuseNextPut` models R2 returning null.
 */
interface FakeBucket extends JournalBucket {
  readonly puts: string[];
  readonly objects: Map<string, Uint8Array>;
  refuseNextPut(): void;
}

function fakeBucket(): FakeBucket {
  const objects = new Map<string, Uint8Array>();
  const puts: string[] = [];
  let refuse = false;
  return {
    puts,
    objects,
    refuseNextPut() {
      refuse = true;
    },
    async put(key, value) {
      if (refuse) {
        refuse = false;
        return null;
      }
      puts.push(key);
      objects.set(key, new Uint8Array(value));
      return { key, size: value.byteLength };
    },
    async get(key) {
      const bytes = objects.get(key);
      if (bytes === undefined) return null;
      return { arrayBuffer: async () => new Uint8Array(bytes).buffer };
    },
    async head(key) {
      const bytes = objects.get(key);
      return bytes === undefined ? null : { key, size: bytes.byteLength };
    },
  };
}

interface Harness {
  readonly journal: Journal;
  readonly state: TestSqliteState;
  close(): void;
}

function harness(bucket?: JournalBucket): Harness {
  const opened = openSqliteState();
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const journal = new Journal(opened.state.storage, { now: () => nowMs, bucket });
  journal.ensureSchema();
  return { journal, state: opened.state, close: opened.close };
}

type Row = Record<string, ArrayBuffer | string | number | null>;
type Binding = string | number;

/** Every row of `query`, through the storage the Journal uses. */
function all(state: TestSqliteState, query: string, ...bindings: Binding[]): Row[] {
  return state.storage.sql.exec(query, ...bindings).toArray();
}

/** How many rows the journal table holds, optionally of one kind. */
function count(state: TestSqliteState, kind?: string): number {
  const bindings: Binding[] = kind === undefined ? [] : [kind];
  const query =
    kind === undefined
      ? "SELECT COUNT(*) AS n FROM journal"
      : "SELECT COUNT(*) AS n FROM journal WHERE kind = ?";
  const row = all(state, query, ...bindings)[0];
  if (row === undefined) throw new Error("counting the journal returned no row");
  return v.parse(v.object({ n: v.number() }), row).n;
}

/** The journal rows' kinds, in sequence order. */
function kinds(state: TestSqliteState): string[] {
  return all(state, "SELECT kind FROM journal ORDER BY seq").map(
    (row) => v.parse(v.object({ kind: v.string() }), row).kind,
  );
}

const StoredBodySchema = v.object({
  body_hash: v.nullable(v.string()),
  body_key: v.nullable(v.string()),
  body_size: v.nullable(v.number()),
  body: v.nullable(v.instance(ArrayBuffer)),
});

/** The body columns of one row, as the storage returns them. */
function storedBody(state: TestSqliteState, seq: number) {
  const row = all(
    state,
    "SELECT body_hash, body_key, body_size, body FROM journal WHERE seq = ?",
    seq,
  )[0];
  if (row === undefined) throw new Error("no journal row at seq " + String(seq));
  return v.parse(StoredBodySchema, row);
}

interface IntentOptions {
  readonly operationId: string;
  readonly path?: string;
  readonly expectedVersion?: string;
  readonly body?: Uint8Array;
}

function appendIntent(journal: Journal, options: IntentOptions) {
  return journal.appendIntent({
    operationId: operationId(options.operationId),
    path: options.path ?? "a.txt",
    expectedVersion: options.expectedVersion ?? "absent",
    body: options.body,
  });
}

function appendOutcome(journal: Journal, result: MutationResult, path = "a.txt") {
  return journal.appendOutcome({ path, result });
}

function post<T>(path: string, body: T): Request {
  return new Request("https://workspace" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const WatermarkOk = v.object({
  ok: v.literal(true),
  watermark: v.object({ throughSeq: v.number(), at: v.string() }),
  truncated: v.number(),
});
const Failure = v.object({ ok: v.literal(false), code: v.string() });

test("sequence numbers are assigned in order and never repeat under concurrent appends", async () => {
  const h = harness();
  try {
    const [first, second] = await Promise.all([
      appendIntent(h.journal, { operationId: "op-a", path: "a.txt" }),
      appendIntent(h.journal, { operationId: "op-b", path: "b.txt" }),
    ]);
    assert.ok(first.status === "appended");
    assert.ok(second.status === "appended");
    expect(new Set([first.entry.seq, second.entry.seq])).toStrictEqual(new Set([1, 2]));
    const event = await h.journal.appendEvent({
      eventKind: "created",
      path: "a.txt",
      version: "sha256:one",
    });
    expect(event.seq).toBe(3);
    const page = await h.journal.read();
    expect(page.entries.map((entry) => entry.seq)).toStrictEqual([1, 2, 3]);
    // Catches: an append rewriting an earlier entry instead of adding a row.
    const firstEntry = page.entries[0];
    assert.ok(firstEntry !== undefined && firstEntry.kind === "intent");
    expect(firstEntry.path).toBe("a.txt");
    expect(firstEntry.at).toBe("2026-01-01T00:00:00.000Z");
  } finally {
    h.close();
  }
});

test("one table holds intents, outcomes, audits, and events", async () => {
  const h = harness();
  try {
    await appendIntent(h.journal, { operationId: "op-1" });
    await appendOutcome(h.journal, {
      status: "applied",
      operationId: "op-1",
      version: "sha256:one",
    });
    await h.journal.appendAudit({
      operationId: operationId("op-2"),
      path: "b.txt",
      reason: "escapes root",
    });
    await h.journal.appendEvent({ eventKind: "deleted", path: "b.txt" });
    expect(kinds(h.state)).toStrictEqual(["intent", "outcome", "audit", "event"]);
    const tables = all(
      h.state,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'journal%' ORDER BY name",
    ).map((row) => v.parse(v.object({ name: v.string() }), row).name);
    expect(tables).toStrictEqual(["journal", "journal_meta"]);
  } finally {
    h.close();
  }
});

test("a body at the inline limit stays in the row and one byte more goes to the bucket", async () => {
  const bucket = fakeBucket();
  const h = harness(bucket);
  try {
    const atLimit = new Uint8Array(JOURNAL_INLINE_BODY_MAX_BYTES).fill(7);
    await appendIntent(h.journal, {
      operationId: "op-inline",
      path: "a.bin",
      body: atLimit,
    });
    expect(bucket.puts).toStrictEqual([]);
    const inline = storedBody(h.state, 1);
    expect(inline.body_key).toBeNull();
    expect(inline.body_size).toBe(JOURNAL_INLINE_BODY_MAX_BYTES);
    expect(inline.body?.byteLength).toBe(JOURNAL_INLINE_BODY_MAX_BYTES);

    const over = new Uint8Array(JOURNAL_INLINE_BODY_MAX_BYTES + 1).fill(9);
    await appendIntent(h.journal, { operationId: "op-object", path: "b.bin", body: over });
    expect(bucket.puts).toHaveLength(1);
    const object = storedBody(h.state, 2);
    expect(object.body).toBeNull();
    assert.ok(object.body_hash !== null);
    assert.ok(object.body_key !== null);
    expect(object.body_key).toBe(journalBodyKey(object.body_hash));
    expect(object.body_size).toBe(over.byteLength);
    expect(bucket.objects.get(object.body_key)).toStrictEqual(over);

    // Catches: reading the reference without the bytes the caller needs to restore.
    const page = await h.journal.read();
    const entry = page.entries[1];
    assert.ok(entry !== undefined && entry.kind === "intent");
    assert.ok(entry.body !== null && entry.body.storage === "object");
    assert.ok(entry.body.bytes !== null);
    expect(entry.body.bytes).toStrictEqual(over);
  } finally {
    h.close();
  }
});

test("a body over the inline limit without an object store is refused", async () => {
  const h = harness();
  try {
    const over = new Uint8Array(JOURNAL_INLINE_BODY_MAX_BYTES + 1);
    await expect(appendIntent(h.journal, { operationId: "op-1", body: over })).rejects.toThrow(
      /object store/,
    );
    expect(count(h.state)).toBe(0);
  } finally {
    h.close();
  }
});

test("a refused body write leaves no row and a retry stores the body once", async () => {
  const bucket = fakeBucket();
  const h = harness(bucket);
  try {
    const over = new Uint8Array(JOURNAL_INLINE_BODY_MAX_BYTES + 1).fill(3);
    bucket.refuseNextPut();
    // Catches: committing the row before R2 accepted the body (ack without the content).
    await expect(appendIntent(h.journal, { operationId: "op-1", body: over })).rejects.toThrow(
      /refused/,
    );
    expect(count(h.state)).toBe(0);

    const appended = await appendIntent(h.journal, { operationId: "op-1", body: over });
    expect(appended.status).toBe("appended");
    expect(bucket.puts).toHaveLength(1);

    // Catches: a retry writing the same body to R2 a second time.
    const retried = await appendIntent(h.journal, { operationId: "op-1", body: over });
    expect(retried.status).toBe("pending");
    expect(bucket.puts).toHaveLength(1);
    expect(count(h.state)).toBe(1);
  } finally {
    h.close();
  }
});

test("one mutation appends three rows and a retry appends none", async () => {
  const h = harness();
  try {
    const body = new TextEncoder().encode("hello");
    await appendIntent(h.journal, { operationId: "op-1", body });
    await appendOutcome(h.journal, {
      status: "applied",
      operationId: "op-1",
      version: "sha256:one",
    });
    await h.journal.appendEvent({ eventKind: "created", path: "a.txt", version: "sha256:one" });
    expect(kinds(h.state)).toStrictEqual(["intent", "outcome", "event"]);
    expect(count(h.state)).toBe(3);
    expect(count(h.state)).toBeLessThanOrEqual(JOURNAL_MAX_ROWS_PER_MUTATION);

    const intentRetry = await appendIntent(h.journal, { operationId: "op-1", body });
    expect(intentRetry.status).toBe("settled");
    const outcomeRetry = await appendOutcome(h.journal, {
      status: "applied",
      operationId: "op-1",
      version: "sha256:one",
    });
    expect(outcomeRetry.status).toBe("settled");
    expect(count(h.state)).toBe(3);

    // A refusal is one audit row, not an intent and an outcome.
    await h.journal.appendAudit({
      operationId: operationId("op-2"),
      path: "b.txt",
      reason: "escapes root",
    });
    expect(count(h.state)).toBe(4);
  } finally {
    h.close();
  }
});

test("the watermark truncates intents and bodies but keeps audits and events", async () => {
  const h = harness();
  try {
    const body = new TextEncoder().encode("hello");
    await appendIntent(h.journal, { operationId: "op-1", body });
    await appendOutcome(h.journal, {
      status: "applied",
      operationId: "op-1",
      version: "sha256:one",
    });
    await h.journal.appendAudit({
      operationId: operationId("op-2"),
      path: "b.txt",
      reason: "escapes root",
    });
    await h.journal.appendEvent({ eventKind: "changed", path: "a.txt", version: "sha256:one" });

    const written = await h.journal.writeWatermark(4);
    expect(written.truncated).toBe(2);
    expect(written.watermark).toStrictEqual({
      throughSeq: 4,
      at: "2026-01-01T00:00:00.000Z",
    });
    // Catches: truncation deleting the audit trail or the event stream with the intents.
    expect(kinds(h.state)).toStrictEqual(["audit", "event"]);
    expect(h.journal.watermark()).toStrictEqual(written.watermark);
    const page = await h.journal.read();
    expect(page.entries.map((entry) => entry.kind)).toStrictEqual(["audit", "event"]);

    // A retry older than the watermark is a new write: the checkpoint already absorbed it.
    const retried = await appendIntent(h.journal, { operationId: "op-1", body });
    expect(retried.status).toBe("appended");
    assert.ok(retried.status === "appended");
    expect(retried.entry.seq).toBe(5);
  } finally {
    h.close();
  }
});

test("a watermark cannot pass an intent that has no outcome", async () => {
  const h = harness();
  try {
    await appendIntent(h.journal, { operationId: "op-1" });
    await h.journal.appendEvent({ eventKind: "created", path: "a.txt", version: "sha256:one" });
    // Catches: a checkpoint deleting the pending intent restore needs to reconcile.
    await expect(h.journal.writeWatermark(2)).rejects.toThrow(JournalWatermarkError);
    expect(h.journal.watermark()).toBeUndefined();
    expect(kinds(h.state)).toStrictEqual(["intent", "event"]);

    await appendOutcome(h.journal, {
      status: "applied",
      operationId: "op-1",
      version: "sha256:one",
    });
    const written = await h.journal.writeWatermark(3);
    expect(written.truncated).toBe(2);
    expect(h.journal.watermark()?.throughSeq).toBe(3);
  } finally {
    h.close();
  }
});

test("the watermark never decreases", async () => {
  const h = harness();
  try {
    await h.journal.writeWatermark(2);
    await expect(h.journal.writeWatermark(1)).rejects.toThrow(JournalWatermarkError);
    expect(h.journal.watermark()?.throughSeq).toBe(2);
  } finally {
    h.close();
  }
});

test("a cursor reads the journal in bounded pages without skipping or repeating", async () => {
  const h = harness();
  try {
    for (let index = 0; index < 10; index += 1) {
      await h.journal.appendAudit({
        operationId: null,
        path: null,
        reason: "attempt " + String(index),
      });
    }
    const seqs: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await h.journal.read({ cursor, limit: 3 });
      expect(page.entries.length).toBeLessThanOrEqual(3);
      seqs.push(...page.entries.map((entry) => entry.seq));
      cursor = page.next;
      pages += 1;
    } while (cursor !== undefined);
    // Catches: reading the whole journal, or a cursor that skips or repeats a page.
    expect(seqs).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(pages).toBe(4);
  } finally {
    h.close();
  }
});

test("an invalid cursor or an out-of-range page size is refused", async () => {
  const h = harness();
  try {
    await h.journal.appendAudit({ operationId: null, path: null, reason: "attempt" });
    await expect(h.journal.read({ limit: 0 })).rejects.toThrow(RangeError);
    await expect(h.journal.read({ limit: JOURNAL_READ_MAX_LIMIT + 1 })).rejects.toThrow(RangeError);
    await expect(h.journal.read({ cursor: "01" })).rejects.toThrow();
    await expect(h.journal.read({ cursor: "x" })).rejects.toThrow();
  } finally {
    h.close();
  }
});

test("a retried operation returns its recorded outcome and appends nothing", async () => {
  const h = harness();
  try {
    await appendIntent(h.journal, { operationId: "op-1" });
    const first = await appendOutcome(h.journal, {
      status: "applied",
      operationId: "op-1",
      version: "sha256:one",
    });
    assert.ok(first.status === "appended");

    // Catches: a retry appending a second intent or a second outcome (double apply).
    const intentRetry = await appendIntent(h.journal, { operationId: "op-1" });
    assert.ok(intentRetry.status === "settled");
    expect(intentRetry.entry.seq).toBe(first.entry.seq);
    const outcomeRetry = await appendOutcome(h.journal, {
      status: "applied",
      operationId: "op-1",
      version: "sha256:two",
    });
    assert.ok(outcomeRetry.status === "settled");
    expect(outcomeRetry.entry.version).toBe("sha256:one");
    expect(h.journal.outcomeFor(operationId("op-1"))?.version).toBe("sha256:one");
    expect(count(h.state)).toBe(2);
  } finally {
    h.close();
  }
});

test("the same operation id with different content is denied", async () => {
  const h = harness();
  try {
    await appendIntent(h.journal, {
      operationId: "op-1",
      path: "a.txt",
      body: new TextEncoder().encode("hello"),
    });
    // Catches: reusing an operation id for a different path or body.
    const otherPath = await appendIntent(h.journal, { operationId: "op-1", path: "b.txt" });
    assert.ok(otherPath.status === "denied");
    expect(otherPath.reason).toBe("operation_id_reused");
    const otherBody = await appendIntent(h.journal, {
      operationId: "op-1",
      path: "a.txt",
      body: new TextEncoder().encode("goodbye"),
    });
    assert.ok(otherBody.status === "denied");
    expect(count(h.state)).toBe(1);
  } finally {
    h.close();
  }
});

test("an outcome without its intent is refused", async () => {
  const h = harness();
  try {
    await expect(
      appendOutcome(h.journal, {
        status: "applied",
        operationId: "op-1",
        version: "sha256:one",
      }),
    ).rejects.toThrow(/no intent/);
    expect(count(h.state)).toBe(0);
  } finally {
    h.close();
  }
});

test("an outcome cannot settle another path's intent", async () => {
  const h = harness();
  try {
    await appendIntent(h.journal, { operationId: "op-1", path: "a.txt" });
    await expect(
      appendOutcome(
        h.journal,
        { status: "applied", operationId: "op-1", version: "sha256:one" },
        "b.txt",
      ),
    ).rejects.toThrow(/path/);
    expect(count(h.state)).toBe(1);
  } finally {
    h.close();
  }
});

test("the Workspace DO writes the journal watermark through its RPC face", async () => {
  const bucket = fakeBucket();
  const opened = openSqliteState();
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  try {
    // The deploy constructs the object as new Workspace(ctx, env); the test passes the same env.
    const workspace = new Workspace(opened.state, { OBJECTS: bucket, now: () => nowMs });
    const journal = new Journal(opened.state.storage, { now: () => nowMs, bucket });
    journal.ensureSchema();
    await appendIntent(journal, {
      operationId: "op-1",
      body: new TextEncoder().encode("hello"),
    });
    await appendOutcome(journal, {
      status: "applied",
      operationId: "op-1",
      version: "sha256:one",
    });
    await journal.appendEvent({ eventKind: "created", path: "a.txt", version: "sha256:one" });

    const response = await workspace.fetch(
      post("/rpc/journal/watermark", { workspaceId: "w1", throughSeq: 3 }),
    );
    expect(response.status).toBe(200);
    const body = v.parse(WatermarkOk, await response.json());
    expect(body.watermark).toStrictEqual({
      throughSeq: 3,
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(body.truncated).toBe(2);

    // A new object over the same storage reads the watermark and the surviving event back.
    const restarted = new Workspace(opened.state, { OBJECTS: bucket, now: () => nowMs });
    const after = new Journal(opened.state.storage, { now: () => nowMs, bucket });
    expect(after.watermark()).toStrictEqual(body.watermark);
    const page = await after.read();
    expect(page.entries.map((entry) => entry.kind)).toStrictEqual(["event"]);

    // Catches: a lowered watermark being applied, which would replay absorbed entries.
    const lower = await restarted.fetch(
      post("/rpc/journal/watermark", { workspaceId: "w1", throughSeq: 1 }),
    );
    expect(lower.status).toBe(409);
    expect(v.parse(Failure, await lower.json()).code).toBe("conflict");
    const invalid = await restarted.fetch(
      post("/rpc/journal/watermark", { workspaceId: "w1", throughSeq: -1 }),
    );
    expect(invalid.status).toBe(400);
  } finally {
    opened.close();
  }
});
