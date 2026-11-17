import { expect, test } from "vitest";
import { isoTimestamp, type ObsLogEntry } from "@hns/core";
import { openSqliteState } from "../../test/support/sqlite.ts";
import { createObsStore, OBS_PRUNE_EVERY } from "./store.ts";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");

function entry(overrides: Partial<ObsLogEntry> = {}): ObsLogEntry {
  return {
    v: 1,
    at: isoTimestamp("2026-11-17T11:59:00.000Z"),
    level: "info",
    event: "http",
    hop: "worker",
    requestId: "req-1",
    path: "/graphql",
    status: 200,
    durationMs: 4,
    ...overrides,
  };
}

function withStore(
  options: Parameters<typeof createObsStore>[1],
  run: (store: ReturnType<typeof createObsStore>, close: () => void) => void,
): void {
  const { state, close } = openSqliteState();
  run(createObsStore(state.storage, { now: () => NOW, ...options }), close);
}

test("events are listed newest first and filtered by level, since, and request id", () => {
  withStore({}, (store, close) => {
    store.append(entry({ at: isoTimestamp("2026-11-17T10:00:00.000Z"), level: "warn" }));
    store.append(
      entry({
        at: isoTimestamp("2026-11-17T11:00:00.000Z"),
        requestId: "req-2",
        event: "fs.op",
        hop: "fs",
      }),
    );
    expect(store.list().map((line) => line.requestId)).toStrictEqual(["req-2", "req-1"]);
    expect(store.list({ level: "warn" })).toHaveLength(1);
    expect(store.list({ requestId: "req-2" })).toHaveLength(1);
    expect(store.list({ since: "2026-11-17T10:30:00.000Z" })).toHaveLength(1);
    expect(store.count()).toBe(2);
    close();
  });
});

// Catches: an unbounded or negative limit reaching SQL.
test("a limit is clamped to the API bound", () => {
  withStore({}, (store, close) => {
    for (let index = 0; index < 3; index += 1) store.append(entry());
    expect(store.list({ limit: 0 })).toHaveLength(1);
    expect(store.list({ limit: 10_000 })).toHaveLength(3);
    close();
  });
});

// Catches: the cap letting the table grow without bound.
test("the cap keeps the newest events and drops the oldest", () => {
  withStore({ maxEvents: 2 }, (store, close) => {
    store.append(entry({ requestId: "first" }));
    store.append(entry({ requestId: "second" }));
    store.append(entry({ requestId: "third" }));
    expect(store.count()).toBe(2);
    expect(store.list().map((line) => line.requestId)).toStrictEqual(["third", "second"]);
    close();
  });
});

// Catches: a retention delete on every append instead of on a bounded interval.
test("retention runs every N appends, not on each one", () => {
  withStore({ retentionDays: 1, pruneEvery: 2 }, (store, close) => {
    store.append(entry({ at: isoTimestamp("2026-11-15T00:00:00.000Z"), requestId: "old" }));
    expect(store.count()).toBe(1);
    store.append(entry({ requestId: "fresh-1" }));
    expect(store.list().map((line) => line.requestId)).toStrictEqual(["fresh-1"]);
    store.append(entry({ requestId: "fresh-2" }));
    expect(store.list().map((line) => line.requestId)).toStrictEqual(["fresh-2", "fresh-1"]);
    expect(store.prune()).toBe(0);
    close();
  });
});

test("prune deletes rows older than the window and reports the count", () => {
  withStore({ retentionDays: 1, pruneEvery: 100 }, (store, close) => {
    store.append(entry({ at: isoTimestamp("2026-11-15T00:00:00.000Z") }));
    store.append(entry());
    expect(store.prune()).toBe(1);
    expect(store.count()).toBe(1);
    close();
  });
});

test("metrics aggregate the last 24 hours and report the retention facts", () => {
  withStore({}, (store, close) => {
    store.append(entry({ durationMs: 10, status: 200 }));
    store.append(entry({ durationMs: 20, status: 200 }));
    store.append(entry({ durationMs: 30, status: 500, level: "error" }));
    store.append(entry({ durationMs: 40, status: 200 }));
    store.append(entry({ event: "tool.call", hop: "agent", status: undefined }));
    store.append(entry({ event: "tool.result", hop: "agent", level: "warn" }));
    store.append(entry({ event: "agent.response", hop: "agent" }));
    const metrics = store.metrics();
    expect(metrics.http.total).toBe(4);
    expect(metrics.http.byStatus).toStrictEqual([
      { status: 200, count: 3 },
      { status: 500, count: 1 },
    ]);
    expect(metrics.http.p50ms).toBe(30);
    expect(metrics.http.p95ms).toBe(40);
    expect(metrics.errors).toBe(1);
    expect(metrics.toolCalls).toBe(1);
    expect(metrics.toolErrors).toBe(1);
    expect(metrics.agentResponses).toBe(1);
    expect(metrics.byHop).toContainEqual({ hop: "worker", count: 4 });
    expect(metrics.byEvent).toContainEqual({ event: "http", count: 4 });
    expect(metrics.stored).toBe(7);
    expect(metrics.retentionDays).toBe(30);
    expect(metrics.maxEvents).toBe(5_000);
    close();
  });
});

// Catches: an unknown stored member being accepted as a known one.
test("a corrupt row fails loudly instead of being defaulted", () => {
  const { state, close } = openSqliteState();
  const store = createObsStore(state.storage, { now: () => NOW });
  state.storage.sql.exec(
    "INSERT INTO obs_events (at, level, event, hop, request_id) VALUES (?, ?, ?, ?, ?)",
    "2026-11-17T11:00:00.000Z",
    "info",
    "made.up",
    "worker",
    "req-1",
  );
  expect(() => store.list()).toThrow();
  close();
});

test("the prune interval is fixed", () => {
  expect(OBS_PRUNE_EVERY).toBe(256);
});
