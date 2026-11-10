import { expect, test } from "vitest";
import {
  assertFiringTransition,
  assertNodeTransition,
  assertRunTransition,
  canFiringTransition,
  canNodeTransition,
  canRunTransition,
} from "../src/workflow.ts";

// Catches: the transition table drifting open without a failing test.
test("run transitions only move forward", () => {
  expect(canRunTransition("queued", "running")).toBe(true);
  expect(canRunTransition("done", "running")).toBe(false);
  expect(() => assertRunTransition("done", "running")).toThrow();
});

test("node transitions allow waiting to resume", () => {
  expect(canNodeTransition("waiting", "running")).toBe(true);
  expect(canNodeTransition("done", "waiting")).toBe(false);
  expect(() => assertNodeTransition("done", "waiting")).toThrow();
});

test("firing transitions stop after done or failed", () => {
  expect(canFiringTransition("running", "done")).toBe(true);
  expect(canFiringTransition("done", "running")).toBe(false);
  expect(() => assertFiringTransition("failed", "done")).toThrow();
});
