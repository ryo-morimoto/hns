import { expect, test } from "vitest";
import { withStore } from "../test/support.ts";

test("events keep JSON detail, filter and return metrics", () => {
  withStore((store) => {
    store.events.add({
      event: "http",
      status: 200,
      durationMs: 10,
      detail: { method: "GET", path: "/api/health" },
    });
    store.events.add({ event: "http", level: "warn", status: 500, durationMs: 30 });
    store.events.add({ event: "chat.submitted" });
    store.events.add({ event: "chat.settled" });
    store.events.add({ event: "tool.result", level: "warn" });
    store.events.add({ event: "agent.response" });
    // An http event without status or duration must not break the metric.
    store.events.add({ event: "http" });
    store.usage.add({ tokens: 7, cost: 0.5 });

    const listed = store.events.list({ limit: 10 });
    expect(listed.length).toBe(7);
    const withDetail = listed.find((event) => event.event === "http" && event.status === 200);
    expect(withDetail?.detail).toStrictEqual({ method: "GET", path: "/api/health" });
    expect(store.events.list({ level: "warn" }).length).toBe(2);

    const metrics = store.events.metrics();
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

test("pruning events drops rows older than the cutoff", () => {
  withStore((store) => {
    store.events.add({ event: "server.start" });
    expect(store.events.list().length).toBe(1);
    expect(store.events.prune(0)).toBe(1);
    expect(store.events.list().length).toBe(0);
  });
});

test("event list limits are clamped", () => {
  withStore((store) => {
    for (let index = 0; index < 3; index += 1) store.events.add({ event: "server.start" });
    expect(store.events.list({ limit: 0 }).length).toBe(1);
    expect(store.events.list({ limit: 10_000 }).length).toBe(3);
  });
});
