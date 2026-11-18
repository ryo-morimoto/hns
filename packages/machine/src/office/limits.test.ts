import { expect, test } from "vitest";
import { describe } from "vitest";
import {
  DEFAULT_OFFICE_LIMITS,
  MIN_OFFICE_TIMEOUT_MS,
  OFFICE_DEADLINE_MARGIN_MS,
} from "@hns/core/office";
import { DEFAULT_LIMITS, officeJobTimeoutMs, resolveLimits } from "../limits.ts";

// The office envelope is a limit like any other: a configuration mistake stops the agent at start
// instead of failing every job, and a job is clamped below the envelope so the machine answers the
// timeout itself.

// Catches: `office.timeoutMs = 30_000` starting an agent whose every preview would be cut off at
// 25 seconds. The check is at start (resolveLimits), which is what startMachineAgent calls.
test("C12: an office budget under a minute is refused at start", () => {
  expect(() => resolveLimits({ office: { timeoutMs: 30_000, maxRssMb: 1024 } })).toThrow(
    /at least 60000/u,
  );
  // The boundary: 60,000 is the least the contract allows, and it starts.
  const limits = resolveLimits({ office: { timeoutMs: MIN_OFFICE_TIMEOUT_MS, maxRssMb: 1024 } });
  expect(limits.office.timeoutMs).toBe(MIN_OFFICE_TIMEOUT_MS);
  expect(limits.office.maxRssMb).toBe(1024);
});

// Catches: the office budget silently taking the 30 second bound of every other operation, which
// would make the envelope redundant and every real conversion a timeout.
test("the office budget and the operation deadline are separate, and the defaults are the contract's", () => {
  expect(DEFAULT_LIMITS.timeoutMs).toBe(30_000);
  expect(DEFAULT_LIMITS.office.timeoutMs).toBe(90_000);
  expect(DEFAULT_LIMITS.maxArtifactBytes).toBe(8 * 1024 * 1024);
  expect(resolveLimits().office).toStrictEqual(DEFAULT_LIMITS.office);
  // A bound of zero is a configuration mistake, not "unlimited".
  expect(() => resolveLimits({ office: { timeoutMs: 90_000, maxRssMb: 0 } })).toThrow(/positive/u);
  expect(() => resolveLimits({ maxArtifactBytes: 0 })).toThrow(/positive/u);
});

// Catches: a job allowed to outlive the machine's envelope (the machine would be cut off
// mid-answer), or one shortened below what its own budget asked for when that is the smaller.
test("a job is clamped below the office envelope, and never above its own budget", () => {
  const envelope = 90_000;
  expect(officeJobTimeoutMs(60_000, envelope)).toBe(60_000);
  expect(officeJobTimeoutMs(120_000, envelope)).toBe(envelope - OFFICE_DEADLINE_MARGIN_MS);
  expect(officeJobTimeoutMs(Number.MAX_SAFE_INTEGER, envelope)).toBe(
    envelope - OFFICE_DEADLINE_MARGIN_MS,
  );
  // The contract's own job budget (60 s) is already below the 85 second clamp the default
  // envelope allows, so a default job is not shortened; a job that asked for the envelope itself
  // loses the margin.
  expect(officeJobTimeoutMs(DEFAULT_OFFICE_LIMITS.timeoutMs, DEFAULT_LIMITS.office.timeoutMs)).toBe(
    DEFAULT_OFFICE_LIMITS.timeoutMs,
  );
  expect(officeJobTimeoutMs(DEFAULT_LIMITS.office.timeoutMs, DEFAULT_LIMITS.office.timeoutMs)).toBe(
    DEFAULT_LIMITS.office.timeoutMs - OFFICE_DEADLINE_MARGIN_MS,
  );
});

describe("the machine's office bounds", () => {
  // Catches: the response bound applied to an artifact range (which would cut every preview at
  // 256 KiB) or the artifact bound applied to a JSON answer.
  test("the JSON answer and the artifact range have their own bounds", () => {
    const limits = resolveLimits();
    expect(limits.maxResponseBytes).toBe(256 * 1024);
    expect(limits.maxArtifactBytes).toBe(8 * 1024 * 1024);
    expect(limits.maxArtifactBytes).toBeGreaterThan(limits.maxResponseBytes);
  });
});
