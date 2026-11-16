import { expect, test } from "vitest";
import { DEFAULT_LIMITS, InFlight, resolveLimits } from "./limits.ts";

test("the defaults are complete and a partial override keeps the rest", () => {
  expect(resolveLimits()).toStrictEqual(DEFAULT_LIMITS);
  const resolved = resolveLimits({ maxConcurrency: 2 });
  expect(resolved.maxConcurrency).toBe(2);
  expect(resolved.timeoutMs).toBe(DEFAULT_LIMITS.timeoutMs);
  expect(resolved.maxRequestBytes).toBe(DEFAULT_LIMITS.maxRequestBytes);
  expect(resolved.maxResponseBytes).toBe(DEFAULT_LIMITS.maxResponseBytes);
});

test("a bound that is not a positive integer stops the agent", () => {
  expect(() => resolveLimits({ timeoutMs: 0 })).toThrow();
  expect(() => resolveLimits({ maxConcurrency: 1.5 })).toThrow();
  expect(() => resolveLimits({ maxRequestBytes: -1 })).toThrow();
  expect(() => new InFlight(0)).toThrow();
});

test("a slot is released once and never below zero", () => {
  const inFlight = new InFlight(2);
  expect(inFlight.count).toBe(0);
  expect(inFlight.enter()).toBe(true);
  expect(inFlight.enter()).toBe(true);
  expect(inFlight.enter()).toBe(false);
  expect(inFlight.count).toBe(2);
  inFlight.leave();
  expect(inFlight.count).toBe(1);
  expect(inFlight.enter()).toBe(true);
  inFlight.leave();
  inFlight.leave();
  expect(inFlight.count).toBe(0);
  expect(() => inFlight.leave()).toThrow();
  expect(inFlight.count).toBe(0);
});
