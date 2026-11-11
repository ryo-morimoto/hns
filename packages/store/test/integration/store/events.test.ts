import { afterAll, beforeAll, expect, test } from "vitest";
import { createD1Harness, type D1Harness } from "../harness.ts";

let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

test("events keep JSON detail, filter and return metrics", async () => {
  await harness.withStore(async (store) => {
    await store.events.add({
      event: "http",
      status: 200,
      durationMs: 10,
      detail: { method: "GET", path: "/api/health" },
    });
    await store.events.add({ event: "http", level: "warn", status: 500, durationMs: 30 });
    await store.events.add({ event: "chat.submitted" });
    await store.events.add({ event: "chat.settled" });
    await store.events.add({ event: "tool.result", level: "warn" });
    await store.events.add({ event: "agent.response" });
    // An http event without status or duration must not break the metric.
    await store.events.add({ event: "http" });
    await store.usage.add({ tokens: 7, cost: 0.5 });

    const listed = await store.events.list({ limit: 10 });
    expect(listed.length).toBe(7);
    const withDetail = listed.find((event) => event.event === "http" && event.status === 200);
    expect(withDetail?.detail).toStrictEqual({ method: "GET", path: "/api/health" });
    expect((await store.events.list({ level: "warn" })).length).toBe(2);

    const metrics = await store.events.metrics();
    expect(metrics.http.total).toBe(3);
    expect(metrics.http.byStatus).toStrictEqual([
      { status: 200, count: 1 },
      { status: 500, count: 1 },
    ]);
    expect(metrics.http.p50ms).toBe(30);
    expect(metrics.http.p95ms).toBe(30);
    expect(metrics.chats["chat.submitted"]).toBe(1);
    expect(metrics.chats["chat.settled"]).toBe(1);
    expect(metrics.toolCalls).toBe(1);
    expect(metrics.toolErrors).toBe(1);
    expect(metrics.agentResponses).toBe(1);
    expect(metrics.errors).toBe(0);
    expect(metrics.tokensToday).toStrictEqual({ turns: 1, tokens: 7, cost: 0.5 });
  });
});

test("pruning events drops rows older than the cutoff", async () => {
  await harness.withStore(async (store) => {
    await store.events.add({ event: "server.start" });
    expect((await store.events.list()).length).toBe(1);
    expect(await store.events.prune(0)).toBe(1);
    expect((await store.events.list()).length).toBe(0);
  });
});

test("event list limits are clamped", async () => {
  await harness.withStore(async (store) => {
    for (let index = 0; index < 3; index += 1) await store.events.add({ event: "server.start" });
    expect((await store.events.list({ limit: 0 })).length).toBe(1);
    expect((await store.events.list({ limit: 10_000 })).length).toBe(3);
  });
});
