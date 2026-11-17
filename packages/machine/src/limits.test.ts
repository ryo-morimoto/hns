import { expect, test } from "vitest";
import { DEFAULT_LIMITS, InFlight, resolveLimits } from "./limits.ts";

test("the defaults are complete and a partial override keeps the rest", () => {
  expect(resolveLimits()).toStrictEqual(DEFAULT_LIMITS);
  const resolved = resolveLimits({ maxConcurrency: 2 });
  expect(resolved.maxConcurrency).toBe(2);
  expect(resolved.timeoutMs).toBe(DEFAULT_LIMITS.timeoutMs);
  expect(resolved.packUploadTimeoutMs).toBe(DEFAULT_LIMITS.packUploadTimeoutMs);
  expect(resolved.maxRequestBytes).toBe(DEFAULT_LIMITS.maxRequestBytes);
  expect(resolved.maxResponseBytes).toBe(DEFAULT_LIMITS.maxResponseBytes);
});

test("a bound that is not a positive integer stops the agent", () => {
  expect(() => resolveLimits({ timeoutMs: 0 })).toThrow();
  expect(() => resolveLimits({ maxConcurrency: 1.5 })).toThrow();
  expect(() => resolveLimits({ maxRequestBytes: -1 })).toThrow();
  expect(() => resolveLimits({ packUploadTimeoutMs: 0 })).toThrow();
  expect(() => new InFlight(0)).toThrow();
});

// Catches: one deadline serving both a JSON operation and a pack upload, so a checkpoint's pack
// is cut off by the operation budget meant for a small request.
test("a pack upload has its own deadline, and the operation's is unchanged", () => {
  const resolved = resolveLimits({ timeoutMs: 1_000, packUploadTimeoutMs: 60_000 });
  expect(resolved.timeoutMs).toBe(1_000);
  expect(resolved.packUploadTimeoutMs).toBe(60_000);
  expect(DEFAULT_LIMITS.packUploadTimeoutMs).toBeGreaterThan(DEFAULT_LIMITS.timeoutMs);
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
