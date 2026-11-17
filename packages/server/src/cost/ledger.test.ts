import { migrateStore, type D1Binding } from "@hns/store";
import { expect, test } from "vitest";
import { openFakeD1 } from "../../../store/test/support/fake-d1.ts";
import {
  monthBounds,
  readMonthlyTotal,
  readProviderMonth,
  recordTurn,
  type CostTurn,
} from "./ledger.ts";

/** A database with the migrations applied and its closer. */
async function open(): Promise<{ db: D1Binding; close(): void }> {
  const fake = openFakeD1();
  await migrateStore(fake.db);
  return { db: fake.db, close: fake.close };
}

const turn = (overrides: Partial<CostTurn> & { readonly id: string }): CostTurn => ({
  conversationId: "2",
  at: new Date("2026-11-17T00:00:00.000Z"),
  outcome: "completed",
  doRows: 9,
  doRequests: 1,
  r2Objects: 0,
  ...overrides,
});

test("a recorded turn is the month's total", async () => {
  const opened = await open();
  try {
    expect(await recordTurn(opened.db, turn({ id: "a" }))).toBe(true);
    expect(await recordTurn(opened.db, turn({ id: "b", doRows: 3, r2Objects: 2 }))).toBe(true);
    expect(await readMonthlyTotal(opened.db, new Date("2026-11-17T00:00:00.000Z"))).toStrictEqual({
      doRows: 12,
      doRequests: 2,
      r2Objects: 2,
    });
  } finally {
    opened.close();
  }
});

// Catches: a resent turn being counted twice, which would refuse runs at half the real usage.
test("a retried turn is not counted twice", async () => {
  const opened = await open();
  try {
    expect(await recordTurn(opened.db, turn({ id: "same" }))).toBe(true);
    expect(await recordTurn(opened.db, turn({ id: "same" }))).toBe(false);
    const total = await readMonthlyTotal(opened.db, new Date("2026-11-17T00:00:00.000Z"));
    expect(total.doRows).toBe(9);
    const rows = await opened.db.prepare("SELECT COUNT(*) AS count FROM cost_turn").first();
    expect(rows).toStrictEqual({ count: 1 });
  } finally {
    opened.close();
  }
});

// Catches: one conversation's request id hiding another conversation's turn from the ledger.
test("the same request id in two conversations is two turns", async () => {
  const opened = await open();
  try {
    expect(await recordTurn(opened.db, turn({ id: "same", conversationId: "2" }))).toBe(true);
    expect(await recordTurn(opened.db, turn({ id: "same", conversationId: "3" }))).toBe(true);
    const counted = await opened.db.prepare("SELECT COUNT(*) AS count FROM cost_turn").first();
    expect(counted).toStrictEqual({ count: 2 });
  } finally {
    opened.close();
  }
});

// Catches: a month total that keeps the previous month's usage, so the limit never resets.
test("the month total ignores the month before", async () => {
  const opened = await open();
  try {
    await recordTurn(opened.db, turn({ id: "nov", at: new Date("2026-11-30T23:00:00.000Z") }));
    await recordTurn(
      opened.db,
      turn({ id: "dec", at: new Date("2026-12-01T00:30:00.000Z"), doRows: 4 }),
    );
    expect(await readMonthlyTotal(opened.db, new Date("2026-12-15T00:00:00.000Z"))).toStrictEqual({
      doRows: 4,
      doRequests: 1,
      r2Objects: 0,
    });
    expect(await readMonthlyTotal(opened.db, new Date("2026-11-15T00:00:00.000Z"))).toStrictEqual({
      doRows: 9,
      doRequests: 1,
      r2Objects: 0,
    });
  } finally {
    opened.close();
  }
});

test("the month bounds are the UTC month", () => {
  expect(monthBounds(new Date("2026-11-17T23:30:00.000Z"))).toStrictEqual({
    start: "2026-11-01T00:00:00.000Z",
    end: "2026-12-01T00:00:00.000Z",
  });
  expect(monthBounds(new Date("2026-12-31T23:59:59.999Z"))).toStrictEqual({
    start: "2026-12-01T00:00:00.000Z",
    end: "2027-01-01T00:00:00.000Z",
  });
});

test("a failed turn is recorded with its outcome", async () => {
  const opened = await open();
  try {
    await recordTurn(opened.db, turn({ id: "failed", outcome: "failed" }));
    const row = await opened.db
      .prepare("SELECT outcome, do_rows FROM cost_turn WHERE id = 'failed'")
      .first();
    expect(row).toStrictEqual({ outcome: "failed", do_rows: 9 });
  } finally {
    opened.close();
  }
});

// Catches: an unknown outcome reaching the table.
test("the outcome column refuses an unknown value", async () => {
  const opened = await open();
  try {
    await recordTurn(opened.db, turn({ id: "x" }));
    await expect(
      opened.db.prepare("UPDATE cost_turn SET outcome = 'weird' WHERE id = 'x'").run(),
    ).rejects.toThrow();
  } finally {
    opened.close();
  }
});

// Catches: a negative or fractional count being written as if it were a measurement.
test("a count that no column could hold is refused", async () => {
  const opened = await open();
  try {
    await expect(recordTurn(opened.db, turn({ id: "neg", doRows: -1 }))).rejects.toThrow(
      RangeError,
    );
    await expect(recordTurn(opened.db, turn({ id: "fraction", doRequests: 1.5 }))).rejects.toThrow(
      RangeError,
    );
    await expect(recordTurn(opened.db, turn({ id: "" }))).rejects.toThrow(RangeError);
    await expect(recordTurn(opened.db, turn({ id: "x", conversationId: "" }))).rejects.toThrow(
      RangeError,
    );
  } finally {
    opened.close();
  }
});

test("the provider month reads the gateway's own row", async () => {
  const opened = await open();
  try {
    await opened.db
      .prepare(
        "UPDATE provider_gateway SET month_key = '2026-11', month_spent = 3, month_limit = 10 WHERE id = 'gateway'",
      )
      .run();
    expect(await readProviderMonth(opened.db, new Date("2026-11-17T00:00:00.000Z"))).toStrictEqual({
      spent: 3,
      limit: 10,
    });
  } finally {
    opened.close();
  }
});

// Catches: a stale period key being read as this month's spend.
test("a provider row from the previous month reports zero spend", async () => {
  const opened = await open();
  try {
    await opened.db
      .prepare(
        "UPDATE provider_gateway SET month_key = '2026-10', month_spent = 3, month_limit = 10 WHERE id = 'gateway'",
      )
      .run();
    expect(await readProviderMonth(opened.db, new Date("2026-11-17T00:00:00.000Z"))).toStrictEqual({
      spent: 0,
      limit: 10,
    });
  } finally {
    opened.close();
  }
});

// Catches: a missing provider row being read as an unlimited budget.
test("a missing provider row is an error", async () => {
  const opened = await open();
  try {
    await opened.db.prepare("DELETE FROM provider_gateway").run();
    await expect(readProviderMonth(opened.db, new Date())).rejects.toThrow(
      /budget row is missing/u,
    );
  } finally {
    opened.close();
  }
});
