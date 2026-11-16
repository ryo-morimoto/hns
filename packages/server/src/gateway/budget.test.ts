import type { D1Binding } from "@hns/store";
import { expect, test } from "vitest";
import { createBudget, dayKey, monthKey } from "./budget.ts";

interface FakeRow {
  readonly changes: number;
  readonly stopped?: number | undefined;
  readonly rowMissing?: boolean | undefined;
}

/**
 * A D1 stand-in that answers the budget's two statements from one scripted outcome.
 *
 * @remarks
 * The real SQL runs in the integration test; here the point is the mapping from D1's
 * `changes` and `stopped` to the reservation result.
 */
const fakeDb = (state: FakeRow): D1Binding => {
  const statement = {
    bind: () => statement,
    run: async () => ({ meta: { changes: state.changes } }),
    all: async () => ({ results: [] }),
    first: async () => (state.rowMissing === true ? null : { stopped: state.stopped ?? 0 }),
  };
  return {
    prepare: () => statement,
    batch: async () => [],
  };
};

test("a write that applied reserves the call", async () => {
  await expect(createBudget(fakeDb({ changes: 1 })).reserve(1, new Date())).resolves.toBe(
    "reserved",
  );
});

test("a write that applied to no row reports the budget as used up", async () => {
  await expect(
    createBudget(fakeDb({ changes: 0, stopped: 0 })).reserve(1, new Date()),
  ).resolves.toBe("exceeded");
});

test("a write that applied to no row reports the stop flag before the budget", async () => {
  await expect(
    createBudget(fakeDb({ changes: 0, stopped: 1 })).reserve(1, new Date()),
  ).resolves.toBe("stopped");
});

// Catches: an unreadable budget row turning into permission to spend.
test("a missing budget row fails closed", async () => {
  const budget = createBudget(fakeDb({ changes: 0, rowMissing: true }));
  await expect(budget.reserve(1, new Date())).rejects.toThrow(/budget row is missing/u);
});

test("a price that is not positive is a range error", async () => {
  const budget = createBudget(fakeDb({ changes: 1 }));
  await expect(budget.reserve(0, new Date())).rejects.toThrow(RangeError);
  await expect(budget.reserve(-1, new Date())).rejects.toThrow(RangeError);
  await expect(budget.refund(0, new Date())).rejects.toThrow(RangeError);
});

test("the period keys are the UTC day and month", () => {
  const at = new Date("2026-11-17T23:30:00.000Z");
  expect(dayKey(at)).toBe("2026-11-17");
  expect(monthKey(at)).toBe("2026-11");
  expect(dayKey(new Date("2026-12-01T00:00:00.000Z"))).toBe("2026-12-01");
  expect(monthKey(new Date("2026-12-01T00:00:00.000Z"))).toBe("2026-12");
});
