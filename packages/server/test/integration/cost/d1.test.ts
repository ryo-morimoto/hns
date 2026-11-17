import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startCost, type CostHarness } from "./harness.ts";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const enabled = existsSync(join(ROOT, "node_modules", ".bin", "cf"));

const NOV = "2026-11-17T00:00:00.000Z";
const DEC = "2026-12-01T00:30:00.000Z";

let harness: CostHarness | undefined;

const running = (): CostHarness => {
  if (harness === undefined) throw new Error("the cost project should be running");
  return harness;
};

// cf dev serializes on the machine's inspector port, so the start can queue behind another suite.
beforeAll(async () => {
  if (!enabled) return;
  harness = await startCost();
}, 300_000);

afterAll(async () => {
  const current = harness;
  harness = undefined;
  await current?.dispose();
});

// Catches: a migration that does not apply to real D1, or default limits that drift from the docs.
test.skipIf(!enabled)("the migration seeds the documented limits", async () => {
  await running().reset();
  await running().migrate();
  expect(await running().limits()).toStrictEqual({
    doRows: 50_000_000,
    doRequests: 1_000_000,
    r2Objects: 1_000_000,
    warnRatio: 0.5,
    criticalRatio: 0.8,
  });
});

// Catches: a real-D1 SUM or an ignored duplicate that does not behave like the unit fake.
test.skipIf(!enabled)("a recorded turn is the month's total and a retry is one row", async () => {
  await running().reset();
  expect(await running().record({ id: "turn-1", at: NOV, doRows: 3, doRequests: 1 })).toBe(true);
  expect(await running().record({ id: "turn-1", at: NOV, doRows: 3, doRequests: 1 })).toBe(false);
  expect(await running().record({ id: "turn-2", at: DEC, doRows: 4 })).toBe(true);
  expect(await running().month(NOV)).toStrictEqual({ doRows: 3, doRequests: 1, r2Objects: 0 });
  expect(await running().month(DEC)).toStrictEqual({ doRows: 4, doRequests: 0, r2Objects: 0 });
});

// Catches: a month limit that never stops a fresh run on the real database.
test.skipIf(!enabled)("the real D1 refuses a run once a month is used up", async () => {
  await running().reset();
  await running().setLimits({ doRows: 5 });
  await running().record({ id: "turn-1", at: NOV, doRows: 5 });
  expect(await running().admit(NOV)).toStrictEqual({
    ok: false,
    refusal: "limit",
    budget: "doRows",
  });
  expect(await running().admit(DEC)).toStrictEqual({ ok: true });
});

// Catches: the provider month being read from another month's counters.
test.skipIf(!enabled)("an exhausted provider month refuses on the real database", async () => {
  await running().reset();
  await running().setProvider({ monthKey: "2026-11", monthSpent: 50, monthLimit: 50 });
  expect(await running().admit(NOV)).toStrictEqual({
    ok: false,
    refusal: "limit",
    budget: "provider",
  });
  await running().setProvider({ monthKey: "2026-10", monthSpent: 50, monthLimit: 50 });
  expect(await running().admit(NOV)).toStrictEqual({ ok: true });
});

// Catches: a missing limit row read as "no limit" on the real database.
test.skipIf(!enabled)("an unreadable gauge refuses on the real database", async () => {
  await running().reset();
  await running().dropLimits();
  expect(await running().admit(NOV)).toStrictEqual({ ok: false, refusal: "gauge" });
});
