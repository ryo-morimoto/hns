import assert from "node:assert/strict";
import { test } from "vitest";
import { formatRelative } from "../../src/app/relativeTime.ts";

const now = new Date("2026-11-07T12:00:00.000Z");

test("relative time compacts minutes, hours, and days", () => {
  assert.equal(formatRelative("2026-11-07T11:59:30.000Z", now), "now");
  assert.equal(formatRelative("2026-11-07T11:48:00.000Z", now), "12m");
  assert.equal(formatRelative("2026-11-07T09:00:00.000Z", now), "3h");
  assert.equal(formatRelative("2026-11-04T12:00:00.000Z", now), "3d");
  assert.equal(formatRelative(null, now), "—");
  assert.equal(formatRelative("not-a-date", now), "—");
});
