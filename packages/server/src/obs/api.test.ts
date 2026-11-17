import { expect, test } from "vitest";
import * as v from "valibot";
import { isoTimestamp, ObsLogEntrySchema, type ObsLogEntry } from "@hns/core";
import { openSqliteState } from "../../test/support/sqlite.ts";
import { handleObsRpc } from "./api.ts";
import { createObsStore, type ObsStore } from "./store.ts";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");

function entry(overrides: Partial<ObsLogEntry> = {}): ObsLogEntry {
  return {
    v: 1,
    at: isoTimestamp("2026-11-17T11:59:00.000Z"),
    level: "info",
    event: "http",
    hop: "worker",
    requestId: "req-1",
    path: "/graphql",
    status: 200,
    durationMs: 4,
    ...overrides,
  };
}

function withStore(
  run: (store: ObsStore, close: () => void) => Promise<void> | void,
): Promise<void> {
  const { state, close } = openSqliteState();
  return Promise.resolve(run(createObsStore(state.storage, { now: () => NOW }), close)).finally(
    close,
  );
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request("https://session.internal" + path, { headers });
}

// oxlint-disable-next-line anti-slop/no-object-parameters -- the append fixture deliberately carries extra keys the boundary must drop.
function post(body: object, headers: Record<string, string> = {}): Request {
  return new Request("https://session.internal/rpc/events", {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "req-1", ...headers },
    body: JSON.stringify(body),
  });
}

test("the events RPC lists the newest first and the metrics RPC aggregates", async () => {
  await withStore(async (store) => {
    store.append(entry());
    store.append(entry({ event: "fs.op", hop: "fs", requestId: "req-2" }));
    const listed = await handleObsRpc(get("/rpc/events?limit=10"), store);
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    const body = v.parse(
      v.object({ ok: v.literal(true), events: v.array(ObsLogEntrySchema) }),
      await listed.json(),
    );
    expect(body.events.map((line) => line.requestId)).toStrictEqual(["req-2", "req-1"]);

    const metrics = await handleObsRpc(get("/rpc/metrics"), store);
    expect(metrics.status).toBe(200);
    expect(await metrics.json()).toMatchObject({
      ok: true,
      metrics: { http: { total: 1 }, stored: 2, retentionDays: 30, maxEvents: 5_000 },
    });
  });
});

// Catches: an unbounded limit or an unknown vocabulary member reaching the store.
test("an invalid query is a typed 400", async () => {
  await withStore(async (store) => {
    for (const path of [
      "/rpc/events?limit=0",
      "/rpc/events?limit=501",
      "/rpc/events?level=debug",
      "/rpc/events?since=not-a-date",
      "/rpc/events?requestId=bad id",
    ]) {
      const response = await handleObsRpc(get(path), store);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
  });
});

// Catches: the edge filing an event under another request id.
test("an append must match the forwarded correlation id", async () => {
  await withStore(async (store) => {
    const accepted = await handleObsRpc(post(entry()), store);
    expect(accepted.status).toBe(201);
    expect(store.count()).toBe(1);

    const mismatch = await handleObsRpc(post(entry(), { "x-request-id": "other" }), store);
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ code: "invalid_request" });

    const missing = await handleObsRpc(
      new Request("https://session.internal/rpc/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry()),
      }),
      store,
    );
    expect(missing.status).toBe(400);
    expect(store.count()).toBe(1);
  });
});

// Catches: a body carrying a secret being stored through the append route.
test("an append body outside the log format is refused", async () => {
  await withStore(async (store) => {
    const response = await handleObsRpc(
      post({ ...entry(), body: "super-secret", headers: { cookie: "super-secret" } }),
      store,
    );
    expect(response.status).toBe(201);
    const listed = await handleObsRpc(get("/rpc/events"), store);
    const text = JSON.stringify(await listed.json());
    expect(text).not.toContain("super-secret");

    const invalid = await handleObsRpc(post({ ...entry(), event: "made.up" }), store);
    expect(invalid.status).toBe(400);
    expect(store.count()).toBe(1);
  });
});

test("a wrong method and an unknown path are refused distinctly", async () => {
  await withStore(async (store) => {
    const wrong = await handleObsRpc(
      new Request("https://session.internal/rpc/metrics", { method: "POST" }),
      store,
    );
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET");
    const missing = await handleObsRpc(get("/rpc/other"), store);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "not_found" });
  });
});
