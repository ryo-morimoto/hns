import assert from "node:assert";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  startFakeProvider,
  startGateway,
  TEST_PROVIDER_KEY,
  type FakeProvider,
  type GatewayHarness,
} from "./harness.ts";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const enabled = existsSync(join(ROOT, "node_modules", ".bin", "cf"));
const PATH = "/v1/ollama-cloud/chat/completions";

let provider: FakeProvider | undefined;
let gateway: GatewayHarness | undefined;

interface Started {
  readonly provider: FakeProvider;
  readonly gateway: GatewayHarness;
}

const started = (): Started => {
  assert.ok(provider !== undefined, "the fake provider should be running");
  assert.ok(gateway !== undefined, "the gateway should be running");
  return { provider, gateway };
};

const ProblemCode = v.object({ code: v.string() });

const problemCode = async (response: Response): Promise<string> =>
  v.parse(ProblemCode, await response.json()).code;

const count = async (responses: Promise<Response>[]): Promise<Map<number, number>> => {
  const statuses = await Promise.all(
    responses.map(async (pending) => {
      const response = await pending;
      await response.text();
      return response.status;
    }),
  );
  const tally = new Map<number, number>();
  for (const status of statuses) tally.set(status, (tally.get(status) ?? 0) + 1);
  return tally;
};

// cf dev serializes on the machine's inspector port, so the start can queue behind another suite.
beforeAll(async () => {
  if (!enabled) return;
  provider = await startFakeProvider();
  gateway = await startGateway(provider.url);
}, 300_000);

afterAll(async () => {
  const current = gateway;
  gateway = undefined;
  await current?.dispose();
  const upstream = provider;
  provider = undefined;
  await upstream?.dispose();
});

// Catches: an unapplied migration or a budget table without its single row.
test.skipIf(!enabled)(
  "the migration leaves one budget row with the documented defaults",
  async () => {
    const { gateway: harness } = started();
    const row = await harness.seed({ reset: true });
    expect(row.day_limit).toBe(5);
    expect(row.month_limit).toBe(50);
    expect(row.day_spent).toBe(0);
    expect(row.month_spent).toBe(0);
    expect(row.stopped).toBe(0);
    // The epoch keys mean the first call after a deploy starts a fresh period.
    expect(row.day_key).toBe("1970-01-01");
    expect(row.month_key).toBe("1970-01");
  },
);

// Catches: a call that is not charged, or an upstream that the key never reaches.
test.skipIf(!enabled)("a successful call charges one unit and reaches the provider", async () => {
  const { provider: upstream, gateway: harness } = started();
  await harness.seed({ dayLimit: 10 });
  const before = upstream.hits();
  const response = await harness.call(PATH);
  expect(response.status).toBe(200);
  expect(upstream.hits()).toBe(before + 1);
  expect(upstream.lastAuthorization()).toBe("Bearer " + TEST_PROVIDER_KEY);
  const row = await harness.row();
  expect(row.day_spent).toBe(1);
  expect(row.month_spent).toBe(1);
});

// Catches: a call over the limit that still reaches the provider.
test.skipIf(!enabled)("an over-budget call is 429 and never reaches the provider", async () => {
  const { provider: upstream, gateway: harness } = started();
  await harness.seed({ dayLimit: 1, daySpent: 1 });
  const before = upstream.hits();
  const response = await harness.call(PATH);
  expect(response.status).toBe(429);
  await expect(problemCode(response)).resolves.toBe("budget_exceeded");
  expect(upstream.hits()).toBe(before);
  expect((await harness.row()).day_spent).toBe(1);
});

// Catches: the emergency stop leaking calls through, or charging while stopped.
test.skipIf(!enabled)("the stop flag refuses with 503 and does not charge", async () => {
  const { provider: upstream, gateway: harness } = started();
  await harness.seed({ stopped: true });
  const before = upstream.hits();
  const response = await harness.call(PATH);
  expect(response.status).toBe(503);
  await expect(problemCode(response)).resolves.toBe("stopped");
  expect(upstream.hits()).toBe(before);
  expect((await harness.row()).day_spent).toBe(0);
});

// Catches: a read-then-write budget, which lets concurrent calls pass the limit.
test.skipIf(!enabled)("parallel calls stop exactly at the day limit", async () => {
  const { provider: upstream, gateway: harness } = started();
  await harness.seed({ dayLimit: 3 });
  const before = upstream.hits();
  const tally = await count(Array.from({ length: 10 }, () => harness.call(PATH)));
  expect(tally.get(200)).toBe(3);
  expect(tally.get(429)).toBe(7);
  expect(upstream.hits()).toBe(before + 3);
  const row = await harness.row();
  expect(row.day_spent).toBe(3);
});

// Catches: a failed provider call that is still billed.
test.skipIf(!enabled)("a failed provider call is refunded", async () => {
  const { provider: upstream, gateway: harness } = started();
  upstream.setStatus(500);
  try {
    await harness.seed({ dayLimit: 10 });
    const before = upstream.hits();
    const response = await harness.call(PATH);
    expect(response.status).toBe(500);
    expect(upstream.hits()).toBe(before + 1);
    const row = await harness.row();
    expect(row.day_spent).toBe(0);
    expect(row.month_spent).toBe(0);
  } finally {
    upstream.setStatus(200);
  }
});

// Catches: counters that never roll over, or a rollover that loses the other period.
test.skipIf(!enabled)("the day and month counters reset at their boundaries", async () => {
  const { gateway: harness } = started();
  await harness.seed({
    dayKey: "2026-11-16",
    monthKey: "2026-11",
    daySpent: 5,
    monthSpent: 10,
    dayLimit: 100,
    monthLimit: 100,
  });
  await expect(harness.reserve({ amount: 1, at: "2026-11-17T10:00:00.000Z" })).resolves.toBe(
    "reserved",
  );
  const sameMonth = await harness.row();
  expect(sameMonth.day_key).toBe("2026-11-17");
  expect(sameMonth.day_spent).toBe(1);
  expect(sameMonth.month_spent).toBe(11);
  await expect(harness.reserve({ amount: 1, at: "2026-12-01T00:00:00.000Z" })).resolves.toBe(
    "reserved",
  );
  const nextMonth = await harness.row();
  expect(nextMonth.month_key).toBe("2026-12");
  expect(nextMonth.day_spent).toBe(1);
  expect(nextMonth.month_spent).toBe(1);
});

// Catches: a late refund subtracting from a period it never charged.
test.skipIf(!enabled)("a refund only subtracts inside the reservation's period", async () => {
  const { gateway: harness } = started();
  await harness.seed({
    dayKey: "2026-11-17",
    monthKey: "2026-11",
    daySpent: 2,
    monthSpent: 2,
    dayLimit: 100,
    monthLimit: 100,
  });
  await harness.refund({ amount: 1, at: "2026-11-16T23:00:00.000Z" });
  const untouched = await harness.row();
  expect(untouched.day_spent).toBe(2);
  await harness.refund({ amount: 1, at: "2026-11-17T09:00:00.000Z" });
  expect((await harness.row()).day_spent).toBe(1);
});
