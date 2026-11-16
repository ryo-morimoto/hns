import { expect, test } from "vitest";
import { alertsBetween, levelFor, minusTurn } from "./alerts.ts";
import type { CostLimits } from "./limits.ts";
import type { CostUsage } from "./ledger.ts";

const LIMITS: CostLimits = {
  doRows: 100,
  doRequests: 100,
  r2Objects: 100,
  warnRatio: 0.5,
  criticalRatio: 0.8,
};

const usage = (doRows: number): CostUsage => ({ doRows, doRequests: 0, r2Objects: 0 });

test("the alert levels start at their ratio and at the limit", () => {
  expect(levelFor(49, 100, LIMITS)).toBeUndefined();
  expect(levelFor(50, 100, LIMITS)).toBe("warn");
  expect(levelFor(79, 100, LIMITS)).toBe("warn");
  expect(levelFor(80, 100, LIMITS)).toBe("critical");
  expect(levelFor(99, 100, LIMITS)).toBe("critical");
  expect(levelFor(100, 100, LIMITS)).toBe("exceeded");
  expect(levelFor(120, 100, LIMITS)).toBe("exceeded");
});

// Catches: an alert firing on every turn instead of only where a ratio is crossed.
test("only a crossing of a level is an alert", () => {
  expect(alertsBetween(usage(49), usage(51), LIMITS)).toStrictEqual([
    { metric: "doRows", level: "warn", used: 51, limit: 100 },
  ]);
  expect(alertsBetween(usage(60), usage(70), LIMITS)).toStrictEqual([]);
  expect(alertsBetween(usage(85), usage(90), LIMITS)).toStrictEqual([]);
  expect(alertsBetween(usage(60), usage(85), LIMITS)).toStrictEqual([
    { metric: "doRows", level: "critical", used: 85, limit: 100 },
  ]);
  expect(alertsBetween(usage(85), usage(100), LIMITS)).toStrictEqual([
    { metric: "doRows", level: "exceeded", used: 100, limit: 100 },
  ]);
});

// Catches: a jump past a ratio reporting every level below it.
test("a jump reports only the highest level reached", () => {
  expect(alertsBetween(usage(0), usage(100), LIMITS)).toStrictEqual([
    { metric: "doRows", level: "exceeded", used: 100, limit: 100 },
  ]);
});

test("each metric is judged against its own limit", () => {
  const before: CostUsage = { doRows: 0, doRequests: 0, r2Objects: 0 };
  const after: CostUsage = { doRows: 0, doRequests: 100, r2Objects: 100 };
  expect(alertsBetween(before, after, LIMITS)).toStrictEqual([
    { metric: "doRequests", level: "exceeded", used: 100, limit: 100 },
    { metric: "r2Objects", level: "exceeded", used: 100, limit: 100 },
  ]);
});

test("the usage a turn added is subtracted back out", () => {
  const total: CostUsage = { doRows: 30, doRequests: 2, r2Objects: 1 };
  const turn: CostUsage = { doRows: 10, doRequests: 1, r2Objects: 0 };
  expect(minusTurn(total, turn)).toStrictEqual({ doRows: 20, doRequests: 1, r2Objects: 1 });
  expect(() => minusTurn(turn, total)).toThrow(RangeError);
});
