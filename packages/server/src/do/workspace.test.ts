import { IsoTimestampSchema, LEASE_REFUSALS, type LeaseRefusal } from "@hns/core";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import * as v from "valibot";
import { Workspace, type WorkspaceState } from "./workspace.ts";

type SqlValue = ArrayBuffer | string | number | null;

const LeaseOk = v.object({
  ok: v.literal(true),
  lease: v.object({
    workspaceId: v.string(),
    machineId: v.string(),
    epoch: v.number(),
    expiresAt: IsoTimestampSchema,
  }),
});
const Refused = v.object({ ok: v.literal(false), code: v.picklist(LEASE_REFUSALS) });
const ReadOk = v.object({ ok: v.literal(true), path: v.string(), version: v.string() });
const ApplyOk = v.object({
  ok: v.literal(true),
  result: v.variant("status", [
    v.object({ status: v.literal("applied"), operationId: v.string(), version: v.string() }),
    v.object({
      status: v.literal("conflict"),
      operationId: v.string(),
      currentVersion: v.string(),
    }),
  ]),
});
const ProtocolFailure = v.object({ ok: v.literal(false), code: v.string() });

/**
 * A SQLite-backed \`DurableObjectState\` for the unit layer.
 *
 * @remarks
 * The real object runs one transaction at a time and retries on conflict; \`queue\` models
 * that contract so a concurrent read-check-write is actually serialized here. The schema and
 * SQL are real \`node:sqlite\`, so a wrong column or constraint fails the test.
 */
function openState() {
  const db = new DatabaseSync(":memory:");
  let queue: Promise<void> = Promise.resolve();
  const state: WorkspaceState = {
    storage: {
      sql: {
        exec(query, ...bindings) {
          const values = bindings.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          );
          const rows = db
            .prepare(query)
            .all(...values)
            .map(toRow);
          let index = 0;
          return {
            next() {
              const value = rows[index];
              if (value === undefined) return { done: true as const };
              index += 1;
              return { value };
            },
            toArray() {
              return rows;
            },
          };
        },
      },
      transaction<T>(run: () => Promise<T>): Promise<T> {
        const result = queue.then(async () => {
          db.exec("BEGIN IMMEDIATE");
          try {
            const value = await run();
            db.exec("COMMIT");
            return value;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        });
        queue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    },
    blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T> {
      return run();
    },
  };
  return { state, close: () => db.close() };
}

/** The values node:sqlite can return; its own SQLOutputValue is not exported. */
type SqlRowValue = null | number | bigint | string | Uint8Array;

/** Parse one node:sqlite row into the DO SQL binding's value shape. */
function toRow(row: Record<string, SqlRowValue>): Record<string, SqlValue> {
  return v.parse(v.record(v.string(), v.union([v.null(), v.string(), v.number()])), row);
}

interface Harness {
  readonly workspace: Workspace;
  advance(ms: number): void;
  close(): void;
}

function harness(leaseTtlMs = 1_000): Harness {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const opened = openState();
  const workspace = new Workspace(opened.state, { now: () => nowMs, leaseTtlMs });
  return {
    workspace,
    advance(ms) {
      nowMs += ms;
    },
    close: opened.close,
  };
}

function post<T>(path: string, body: T): Request {
  return new Request("https://workspace" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string): Request {
  return new Request("https://workspace" + path);
}

interface LeaseBody {
  readonly workspaceId: string;
  readonly machineId: string;
  readonly epoch: number;
}

function leaseBody(overrides: Partial<LeaseBody> = {}): LeaseBody {
  return { workspaceId: "w1", machineId: "m1", epoch: 1, ...overrides };
}

interface ApplyBody extends LeaseBody {
  readonly operationId: string;
  readonly path: string;
  readonly expectedVersion: string;
  readonly version: string;
}

function applyBody(overrides: Partial<ApplyBody> = {}): ApplyBody {
  return {
    workspaceId: "w1",
    machineId: "m1",
    epoch: 1,
    operationId: "op-1",
    path: "a.txt",
    expectedVersion: "absent",
    version: "sha256:one",
    ...overrides,
  };
}

async function acquire(workspace: Workspace, body: LeaseBody) {
  const response = await workspace.fetch(post("/rpc/lease/acquire", body));
  expect(response.status).toBe(200);
  return v.parse(LeaseOk, await response.json()).lease;
}

async function refusalOf(response: Response): Promise<LeaseRefusal> {
  expect(response.status).toBe(409);
  return v.parse(Refused, await response.json()).code;
}

async function readVersion(workspace: Workspace, path: string): Promise<string> {
  const response = await workspace.fetch(get("/rpc/read?path=" + encodeURIComponent(path)));
  expect(response.status).toBe(200);
  return v.parse(ReadOk, await response.json()).version;
}

async function apply(workspace: Workspace, body: ApplyBody) {
  const response = await workspace.fetch(post("/rpc/apply", body));
  expect(response.status).toBe(200);
  return v.parse(ApplyOk, await response.json()).result;
}

test("a write without a lease is refused and records no version", async () => {
  const h = harness();
  try {
    const response = await h.workspace.fetch(post("/rpc/apply", applyBody()));
    expect(await refusalOf(response)).toBe("lease_not_held");
    expect(await readVersion(h.workspace, "a.txt")).toBe("absent");
  } finally {
    h.close();
  }
});

test("a lease fails closed at its exact expiry", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    h.advance(1_000);
    const response = await h.workspace.fetch(post("/rpc/apply", applyBody()));
    expect(await refusalOf(response)).toBe("lease_expired");
    expect(await readVersion(h.workspace, "a.txt")).toBe("absent");
  } finally {
    h.close();
  }
});

test("an old epoch from the previous holder is refused", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody({ machineId: "m1" }));
    h.advance(1_000);
    const second = await acquire(h.workspace, leaseBody({ machineId: "m2" }));
    expect(second.epoch).toBe(2);
    const stale = await h.workspace.fetch(
      post("/rpc/apply", applyBody({ machineId: "m1", epoch: 1, version: "sha256:old" })),
    );
    expect(await refusalOf(stale)).toBe("lease_epoch_stale");
    expect(await readVersion(h.workspace, "a.txt")).toBe("absent");
    const applied = await apply(
      h.workspace,
      applyBody({ machineId: "m2", epoch: 2, version: "sha256:new" }),
    );
    expect(applied).toStrictEqual({
      status: "applied",
      operationId: "op-1",
      version: "sha256:new",
    });
  } finally {
    h.close();
  }
});

// Catches: moving the version check outside the transaction, so both writes pass it.
test("only one of two concurrent writes at the same expected version applies", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    const responses = await Promise.all([
      h.workspace.fetch(
        post("/rpc/apply", applyBody({ operationId: "op-a", version: "sha256:a" })),
      ),
      h.workspace.fetch(
        post("/rpc/apply", applyBody({ operationId: "op-b", version: "sha256:b" })),
      ),
    ]);
    const results = await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(200);
        return v.parse(ApplyOk, await response.json()).result;
      }),
    );
    const applied = results.find((result) => result.status === "applied");
    const conflict = results.find((result) => result.status === "conflict");
    if (
      applied === undefined ||
      conflict === undefined ||
      applied.status !== "applied" ||
      conflict.status !== "conflict"
    ) {
      throw new Error("one write should apply and the other should conflict");
    }
    expect(conflict.currentVersion).toBe(applied.version);
    expect(await readVersion(h.workspace, "a.txt")).toBe(applied.version);
  } finally {
    h.close();
  }
});

test("a stale expected version conflicts without changing the table", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    const first = await apply(h.workspace, applyBody({ version: "sha256:one" }));
    expect(first).toStrictEqual({ status: "applied", operationId: "op-1", version: "sha256:one" });
    const second = await apply(
      h.workspace,
      applyBody({ operationId: "op-2", version: "sha256:two", expectedVersion: "absent" }),
    );
    expect(second).toStrictEqual({
      status: "conflict",
      operationId: "op-2",
      currentVersion: "sha256:one",
    });
    expect(await readVersion(h.workspace, "a.txt")).toBe("sha256:one");
  } finally {
    h.close();
  }
});

test("a second acquisition is refused without reissuing the epoch", async () => {
  const h = harness();
  try {
    const first = await acquire(h.workspace, leaseBody());
    expect(first.epoch).toBe(1);
    const second = await h.workspace.fetch(post("/rpc/lease/acquire", leaseBody()));
    expect(await refusalOf(second)).toBe("lease_not_held");
    const applied = await apply(h.workspace, applyBody({ epoch: 1 }));
    expect(applied.status).toBe("applied");
  } finally {
    h.close();
  }
});

test("a released lease is not held and the next acquisition moves the epoch", async () => {
  const h = harness();
  try {
    const first = await acquire(h.workspace, leaseBody());
    const released = await h.workspace.fetch(
      post("/rpc/lease/release", leaseBody({ epoch: first.epoch })),
    );
    expect(released.status).toBe(200);
    const afterRelease = await h.workspace.fetch(post("/rpc/apply", applyBody()));
    expect(await refusalOf(afterRelease)).toBe("lease_not_held");
    const second = await acquire(h.workspace, leaseBody());
    expect(second.epoch).toBe(2);
  } finally {
    h.close();
  }
});

test("renewing extends a live lease past its original expiry", async () => {
  const h = harness();
  try {
    const first = await acquire(h.workspace, leaseBody());
    h.advance(600);
    const renewed = await h.workspace.fetch(post("/rpc/lease/renew", leaseBody({ epoch: 1 })));
    expect(renewed.status).toBe(200);
    const lease = v.parse(LeaseOk, await renewed.json()).lease;
    expect(lease.epoch).toBe(first.epoch);
    expect(Date.parse(lease.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt));
    h.advance(500);
    const applied = await apply(h.workspace, applyBody());
    expect(applied.status).toBe("applied");
  } finally {
    h.close();
  }
});

test("a machine that does not hold the lease is refused", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody({ machineId: "m1" }));
    const response = await h.workspace.fetch(
      post("/rpc/apply", applyBody({ machineId: "m2", epoch: 1 })),
    );
    expect(await refusalOf(response)).toBe("lease_not_held");
    expect(await readVersion(h.workspace, "a.txt")).toBe("absent");
  } finally {
    h.close();
  }
});

test("read reports absent before a write and the recorded version after", async () => {
  const h = harness();
  try {
    expect(await readVersion(h.workspace, "a.txt")).toBe("absent");
    await acquire(h.workspace, leaseBody());
    await apply(h.workspace, applyBody({ version: "sha256:one" }));
    expect(await readVersion(h.workspace, "a.txt")).toBe("sha256:one");
  } finally {
    h.close();
  }
});

test("a write for another workspace is refused", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody({ workspaceId: "w1" }));
    const response = await h.workspace.fetch(
      post("/rpc/lease/acquire", leaseBody({ workspaceId: "w2", machineId: "m2" })),
    );
    expect(response.status).toBe(400);
    expect(v.parse(ProtocolFailure, await response.json()).code).toBe("invalid_request");
    const applied = await apply(h.workspace, applyBody());
    expect(applied.status).toBe("applied");
  } finally {
    h.close();
  }
});

test("an unsafe path is refused by apply and read", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    for (const path of ["/etc/passwd", "../secret", "a/../b", "C:\\secret", "a\0b"]) {
      const response = await h.workspace.fetch(post("/rpc/apply", applyBody({ path })));
      expect(response.status, path).toBe(400);
      const read = await h.workspace.fetch(get("/rpc/read?path=" + encodeURIComponent(path)));
      expect(read.status, path).toBe(400);
    }
    expect(await readVersion(h.workspace, "a.txt")).toBe("absent");
  } finally {
    h.close();
  }
});
