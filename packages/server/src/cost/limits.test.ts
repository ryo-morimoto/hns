import { migrateStore, type D1Binding } from "@hns/store";
import { expect, test } from "vitest";
import { openFakeD1 } from "../../test/support/d1.ts";
import { limitFor, readCostLimits } from "./limits.ts";

/** A database with the migrations applied and its closer. */
async function open(): Promise<{ db: D1Binding; close(): void }> {
  const fake = openFakeD1();
  await migrateStore(fake.db);
  return { db: fake.db, close: fake.close };
}

/** A binding that answers every statement with one scripted row. */
function stubDb(row: Readonly<Record<string, number>>): D1Binding {
  const statement = {
    bind: () => statement,
    all: async () => ({ results: [] }),
    first: async () => row,
    run: async () => ({ meta: { changes: 0 } }),
  };
  return { prepare: () => statement, batch: async () => [] };
}

test("the seeded limits are the free-tier figures", async () => {
  const opened = await open();
  try {
    expect(await readCostLimits(opened.db)).toStrictEqual({
      doRows: 50_000_000,
      doRequests: 1_000_000,
      r2Objects: 1_000_000,
      warnRatio: 0.5,
      criticalRatio: 0.8,
    });
  } finally {
    opened.close();
  }
});

// Catches: an operator changing the policy needing a new migration.
test("a limit is changed with an update, not a migration", async () => {
  const opened = await open();
  try {
    await opened.db.prepare("UPDATE cost_limits SET do_rows_limit = 100 WHERE id = 'cost'").run();
    expect((await readCostLimits(opened.db)).doRows).toBe(100);
  } finally {
    opened.close();
  }
});

// Catches: a missing limit row being read as "no limit" instead of failing closed.
test("a missing limit row is an error", async () => {
  const opened = await open();
  try {
    await opened.db.prepare("DELETE FROM cost_limits").run();
    await expect(readCostLimits(opened.db)).rejects.toThrow(/limit row is missing/u);
  } finally {
    opened.close();
  }
});

// Catches: an unordered alert ratio turning every turn into an alert.
test("unusable alert ratios are refused", async () => {
  const row = {
    do_rows_limit: 100,
    do_requests_limit: 100,
    r2_objects_limit: 100,
    warn_ratio: 0.9,
    critical_ratio: 0.5,
  };
  await expect(readCostLimits(stubDb(row))).rejects.toThrow(/warn < critical/u);
});

test("each metric keeps its own limit", async () => {
  const opened = await open();
  try {
    await opened.db
      .prepare(
        "UPDATE cost_limits SET do_rows_limit = 7, do_requests_limit = 11, r2_objects_limit = 13 WHERE id = 'cost'",
      )
      .run();
    const limits = await readCostLimits(opened.db);
    expect(limitFor(limits, "doRows")).toBe(7);
    expect(limitFor(limits, "doRequests")).toBe(11);
    expect(limitFor(limits, "r2Objects")).toBe(13);
  } finally {
    opened.close();
  }
});
