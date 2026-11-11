import { expect, test } from "vitest";
import { createRowBudget, DEFAULT_LIMITS } from "./limits.ts";

test("a row budget spends down to exactly zero", () => {
  const budget = createRowBudget(10);
  expect(budget.remaining).toBe(10);
  expect(budget.spend(4)).toBe(true);
  expect(budget.remaining).toBe(6);
  expect(budget.spend(6)).toBe(true);
  expect(budget.remaining).toBe(0);
});

// Catches: a list that silently returns a partial result after the budget is gone.
test("a spend over the remaining rows is refused and changes nothing", () => {
  const budget = createRowBudget(10);
  expect(budget.spend(4)).toBe(true);
  expect(budget.spend(7)).toBe(false);
  expect(budget.remaining).toBe(6);
  expect(budget.spend(0)).toBe(true);
});

test("an invalid budget or spend is a range error", () => {
  expect(() => createRowBudget(-1)).toThrow(RangeError);
  expect(() => createRowBudget(1.5)).toThrow(RangeError);
  const budget = createRowBudget(1);
  expect(() => budget.spend(-1)).toThrow(RangeError);
  expect(() => budget.spend(0.5)).toThrow(RangeError);
});

test("the production limits are the documented values", () => {
  expect(DEFAULT_LIMITS.maxBodyBytes).toBe(1_048_576);
  expect(DEFAULT_LIMITS.maxRequestMs).toBe(10_000);
  expect(DEFAULT_LIMITS.maxRowsPerRequest).toBe(500);
  expect(DEFAULT_LIMITS.maxRowsPerList).toBe(100);
});
