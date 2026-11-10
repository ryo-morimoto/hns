import { expect, test } from "vitest";
import { formatRelative } from "./relativeTime.ts";

const now = new Date("2026-11-07T12:00:00.000Z");

test("relative time compacts minutes, hours, and days", () => {
  expect(formatRelative("2026-11-07T11:59:30.000Z", now)).toBe("now");
  expect(formatRelative("2026-11-07T11:48:00.000Z", now)).toBe("12m");
  expect(formatRelative("2026-11-07T09:00:00.000Z", now)).toBe("3h");
  expect(formatRelative("2026-11-04T12:00:00.000Z", now)).toBe("3d");
  expect(formatRelative(null, now)).toBe("—");
  expect(formatRelative("not-a-date", now)).toBe("—");
});
