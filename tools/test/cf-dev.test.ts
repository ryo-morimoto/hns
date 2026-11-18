import { expect, test } from "vitest";
import { judgeLock, mayTakeOverAfterDeadline, parseLock, sameRecord } from "./cf-dev.ts";
import type { LockRecord, LockSnapshot } from "./cf-dev.ts";

const record = (token: string): LockRecord => ({
  pid: 4_321,
  at: "2026-11-17T00:00:00.000Z",
  token,
});

const held = (token: string, ageMs: number): LockSnapshot => ({
  state: "held",
  record: record(token),
  ageMs,
});

const torn = (ageMs: number): LockSnapshot => ({ state: "unreadable", ageMs });

// Catches: a record that gained a field (the child) being dropped, which would hide the orphan.
test("a record with the child it recorded parses", () => {
  expect(
    parseLock(JSON.stringify({ pid: 7, at: "2026-11-17T00:00:00.000Z", token: "t", child: 12 })),
  ).toStrictEqual({ pid: 7, at: "2026-11-17T00:00:00.000Z", token: "t", child: 12 });
});

// Catches: a torn or incomplete record being read as an owner, so no one takes the lock over.
test("a torn or incomplete record parses to nothing", () => {
  expect(parseLock('{"pid":7,"at":')).toBeNull();
  expect(parseLock(JSON.stringify({ pid: 7, at: "2026-11-17T00:00:00.000Z" }))).toBeNull();
  expect(parseLock(JSON.stringify({ pid: 0, at: "not a timestamp", token: "t" }))).toBeNull();
});

test("an absent record is free to take", () => {
  expect(judgeLock({ state: "absent" }, false)).toBe("free");
});

// Catches: a start stealing the lock from a worker that is still running cf dev.
test("a record whose owner lives and is young is held", () => {
  expect(judgeLock(held("t", 1_000), true)).toBe("held");
});

test("a record whose owner died is abandoned", () => {
  expect(judgeLock(held("t", 1_000), false)).toBe("abandoned");
});

// Catches: a worker that died inside a test leaving the lock for ten minutes.
test("a record older than the stale window is abandoned even while its owner lives", () => {
  expect(judgeLock(held("t", 10 * 60_000), true)).toBe("abandoned");
});

// Catches: a takeover deleting a record another worker is in the middle of writing.
test("a torn record is held while a writer could still be writing it", () => {
  expect(judgeLock(torn(1_000), false)).toBe("held");
});

test("a torn record nobody finished writing is abandoned", () => {
  expect(judgeLock(torn(6_000), false)).toBe("abandoned");
});

test("the record that was judged is the one a takeover may replace", () => {
  expect(sameRecord(held("stale", 10 * 60_000), held("stale", 11 * 60_000))).toBe(true);
  expect(sameRecord(torn(6_000), torn(7_000))).toBe(true);
});

// Catches: two waiters holding the lock at once — the second deleted the first's fresh record
// because it replaced the record it judged instead of re-reading it under the guard.
test("a takeover refuses a record another waiter has already replaced", () => {
  expect(sameRecord(held("stale", 10 * 60_000), held("winner", 5))).toBe(false);
});

// Catches: a worker killed between writing the record and starting cf dev, whose pid lives on, stalling
// every suite for the ten minutes the lock waits for a record it will never see released.
test("a held record with a free inspector port is taken over once the deadline passes", () => {
  expect(mayTakeOverAfterDeadline(true)).toBe(true);
  expect(mayTakeOverAfterDeadline(false)).toBe(false);
});

// Catches: a takeover deleting the record of a start that released and let a new holder create.
test("a takeover refuses a record that changed shape under it", () => {
  expect(sameRecord(held("stale", 10 * 60_000), { state: "absent" })).toBe(false);
  expect(sameRecord(torn(6_000), held("winner", 5))).toBe(false);
  expect(sameRecord(torn(6_000), torn(1_000))).toBe(false);
});
