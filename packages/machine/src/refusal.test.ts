import { expect, test } from "vitest";
import { REFUSAL_CODES, refusalStatus, type RefusalCode } from "./refusal.ts";

/**
 * The statuses the machine answered with before the table took over, read from the switch this
 * change replaced. The table must reproduce them exactly: these are what a machine client and
 * the Worker's signed client already branch on.
 */
const PREVIOUS: ReadonlyArray<readonly [RefusalCode, number]> = [
  ["unauthorized", 401],
  ["stale_request", 401],
  ["replayed", 409],
  ["stale_connection", 409],
  ["invalid_request", 400],
  ["path_denied", 400],
  ["forbidden", 403],
  ["not_found", 404],
  ["busy", 429],
  ["too_large", 413],
  ["deadline_exceeded", 408],
  ["method_not_allowed", 405],
  ["internal", 500],
];

// Catches: a refusal status drifting while the code-to-status table was introduced.
test("every refusal code keeps the status the machine answered with", () => {
  for (const [code, status] of PREVIOUS) {
    expect(refusalStatus(code), code).toBe(status);
  }
});

// Catches: a refusal code added to the vocabulary without a status (a silent 500).
test("the vocabulary and the status table cover the same codes", () => {
  expect(new Set(REFUSAL_CODES)).toStrictEqual(new Set(PREVIOUS.map(([code]) => code)));
  expect(REFUSAL_CODES).toHaveLength(PREVIOUS.length);
});
