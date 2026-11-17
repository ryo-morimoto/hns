import { IsoTimestampSchema, LEASE_REFUSALS, operationId, type LeaseRefusal } from "@hns/core";
import type { JournalOutcomeEntry } from "@hns/store";
import { expect, test } from "vitest";
import * as v from "valibot";
import { base64Of, fakeMachine, versionOfText } from "../../test/support/machine.ts";
import { openSqliteState } from "../../test/support/sqlite.ts";
import { Journal } from "./journal.ts";
import { Workspace } from "./workspace.ts";

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
const ReadOk = v.object({
  ok: v.literal(true),
  path: v.string(),
  version: v.string(),
  content: v.string(),
  externalChange: v.boolean(),
});
const ApplyOk = v.object({
  ok: v.literal(true),
  result: v.variant("status", [
    v.object({ status: v.literal("applied"), operationId: v.string(), version: v.string() }),
    v.object({
      status: v.literal("conflict"),
      operationId: v.string(),
      currentVersion: v.string(),
    }),
    v.object({
      status: v.literal("unknown"),
      operationId: v.string(),
      reason: v.picklist(["io", "crash", "timeout"]),
    }),
  ]),
});
const Denied = v.object({ ok: v.literal(false), code: v.literal("denied") });
const ProtocolFailure = v.object({ ok: v.literal(false), code: v.string() });

interface Harness {
  readonly workspace: Workspace;
  readonly journal: Journal;
  readonly machine: ReturnType<typeof fakeMachine>;
  advance(ms: number): void;
  close(): void;
}

function harness(options: { readonly machine?: boolean } = {}): Harness {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const opened = openSqliteState();
  const machine = fakeMachine();
  const settings = { now: () => nowMs, leaseTtlMs: 1_000 };
  const workspace =
    options.machine === false
      ? new Workspace(opened.state, settings)
      : new Workspace(opened.state, { ...settings, files: machine });
  const journal = new Journal(opened.state.storage, { now: () => nowMs });
  return {
    workspace,
    journal,
    machine,
    advance(ms) {
      nowMs += ms;
    },
    close: opened.close,
  };
}

function post<T>(path: string, body: T): Request {
  return new Request("https://workspace" + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "request-1" },
    body: JSON.stringify(body),
  });
}

function get(path: string): Request {
  return new Request("https://workspace" + path, {
    headers: { "x-request-id": "request-1" },
  });
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
  readonly projectRoot: string;
  readonly path: string;
  readonly expectedVersion: string;
  /** base64 of the text the caller wants written. */
  readonly content: string;
}

function applyBody(overrides: Partial<ApplyBody> = {}): ApplyBody {
  return {
    workspaceId: "w1",
    machineId: "m1",
    epoch: 1,
    operationId: "op-1",
    projectRoot: "project",
    path: "a.txt",
    expectedVersion: "absent",
    content: base64Of("one"),
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

async function apply(workspace: Workspace, body: ApplyBody) {
  const response = await workspace.fetch(post("/rpc/apply", body));
  expect(response.status, await response.clone().text()).toBe(200);
  return v.parse(ApplyOk, await response.json()).result;
}

/** A read of one file; the project defaults to the one applyBody names. */
async function read(workspace: Workspace, path: string, projectRoot = "project") {
  const query = new URLSearchParams({ projectRoot, path });
  const response = await workspace.fetch(get("/rpc/read?" + query.toString()));
  return { status: response.status, body: await response.json() };
}

test("a write without a lease is refused and the machine is not asked", async () => {
  const h = harness();
  try {
    const response = await h.workspace.fetch(post("/rpc/apply", applyBody()));
    expect(await refusalOf(response)).toBe("lease_not_held");
    expect(h.machine.writes).toStrictEqual([]);
    expect(h.machine.contentOf("project/a.txt")).toBeUndefined();
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
    expect(h.machine.writes).toStrictEqual([]);
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
      post("/rpc/apply", applyBody({ machineId: "m1", epoch: 1 })),
    );
    expect(await refusalOf(stale)).toBe("lease_epoch_stale");
    const applied = await apply(
      h.workspace,
      applyBody({ machineId: "m2", epoch: 2, content: base64Of("new") }),
    );
    expect(applied).toStrictEqual({
      status: "applied",
      operationId: "op-1",
      version: versionOfText("new"),
    });
  } finally {
    h.close();
  }
});

// Catches: the version compare being moved to the DO and done once, so both writes pass it.
test("only one of two concurrent writes at the same expected version applies", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    const responses = await Promise.all([
      h.workspace.fetch(
        post("/rpc/apply", applyBody({ operationId: "op-a", content: base64Of("a") })),
      ),
      h.workspace.fetch(
        post("/rpc/apply", applyBody({ operationId: "op-b", content: base64Of("b") })),
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
    expect(h.machine.contentOf("project/a.txt")).toBe(
      applied.version === versionOfText("a") ? "a" : "b",
    );
  } finally {
    h.close();
  }
});

// Catches: trusting the recorded version table instead of the machine's re-hash.
test("the machine's re-hash decides a conflict, not the version table", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    const first = await apply(h.workspace, applyBody());
    expect(first.status).toBe("applied");
    // An agent's shell rewrites the file behind the Workspace's back.
    h.machine.seed("project/a.txt", "two");
    const second = await apply(
      h.workspace,
      applyBody({
        operationId: "op-2",
        expectedVersion: versionOfText("one"),
        content: base64Of("three"),
      }),
    );
    expect(second).toStrictEqual({
      status: "conflict",
      operationId: "op-2",
      currentVersion: versionOfText("two"),
    });
    expect(h.machine.contentOf("project/a.txt")).toBe("two");
  } finally {
    h.close();
  }
});

// Catches: an answer that never arrived being rounded to applied or conflict.
test("a missing answer is unknown and a retry keeps the recorded outcome", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    h.machine.failNext();
    const first = await apply(h.workspace, applyBody());
    expect(first).toStrictEqual({
      status: "unknown",
      operationId: "op-1",
      reason: "timeout",
    });
    expect(h.machine.writes).toHaveLength(1);
    const retry = await apply(h.workspace, applyBody());
    expect(retry).toStrictEqual(first);
    expect(h.machine.writes).toHaveLength(1);
    expect(await h.journal.outcomeFor(operationId("op-1"))).toMatchObject({
      status: "unknown",
      reason: "timeout",
    });
  } finally {
    h.close();
  }
});

// Catches: a DO crash between the machine's apply and the outcome losing the write.
test("a pending intent is reconciled by the machine's content hash", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    const text = "one";
    const content = new TextEncoder().encode(text);
    await h.journal.appendIntent({
      operationId: operationId("op-1"),
      path: "a.txt",
      expectedVersion: "absent",
      body: content,
    });
    // The machine applied it before the crash; the DO has only the intent.
    h.machine.seed("project/a.txt", text);
    const result = await apply(h.workspace, applyBody({ content: base64Of(text) }));
    expect(result).toStrictEqual({
      status: "applied",
      operationId: "op-1",
      version: versionOfText(text),
    });
    expect(h.machine.writes).toHaveLength(1);
    expect(await h.journal.outcomeFor(operationId("op-1"))).toMatchObject({ status: "applied" });
  } finally {
    h.close();
  }
});

// Catches: a definite refusal leaving a pending intent that no checkpoint could truncate.
test("a definite machine refusal settles a denied outcome and a retry returns it", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    h.machine.denyNext("path_denied");
    const response = await h.workspace.fetch(post("/rpc/apply", applyBody()));
    expect(response.status).toBe(400);
    expect(v.parse(Denied, await response.json()).code).toBe("denied");
    const retry = await h.workspace.fetch(post("/rpc/apply", applyBody()));
    expect(retry.status).toBe(400);
    expect(v.parse(Denied, await retry.json()).code).toBe("denied");
    expect(h.machine.writes).toHaveLength(1);
    const stored: JournalOutcomeEntry | undefined = await h.journal.outcomeFor(operationId("op-1"));
    expect(stored).toMatchObject({ status: "denied", reason: "path_denied" });
  } finally {
    h.close();
  }
});

test("the same operation id with different content is denied before the machine", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    expect((await apply(h.workspace, applyBody())).status).toBe("applied");
    const response = await h.workspace.fetch(
      post("/rpc/apply", applyBody({ content: base64Of("two") })),
    );
    expect(response.status).toBe(409);
    expect(v.parse(ProtocolFailure, await response.json()).code).toBe("conflict");
    expect(h.machine.writes).toHaveLength(1);
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
    expect(h.machine.writes).toStrictEqual([]);
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

// Catches: a workspace mixing two projects on one machine.
test("a write for another project root is refused before the machine", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    expect((await apply(h.workspace, applyBody({ projectRoot: "one" }))).status).toBe("applied");
    const response = await h.workspace.fetch(
      post("/rpc/apply", applyBody({ operationId: "op-2", projectRoot: "two" })),
    );
    expect(response.status).toBe(400);
    expect(v.parse(ProtocolFailure, await response.json()).code).toBe("invalid_request");
    expect(h.machine.writes).toHaveLength(1);
  } finally {
    h.close();
  }
});

test("an unsafe path is refused by apply and read without calling the machine", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    for (const path of ["/etc/passwd", "../secret", "a/../b", "C:\\secret", "a\0b"]) {
      const response = await h.workspace.fetch(post("/rpc/apply", applyBody({ path })));
      expect(response.status, path).toBe(400);
      const readResult = await read(h.workspace, path);
      expect(readResult.status, path).toBe(400);
    }
    expect(h.machine.writes).toStrictEqual([]);
    expect(h.machine.reads).toStrictEqual([]);
  } finally {
    h.close();
  }
});

// Catches: a read serving a cached value instead of what the machine has now.
test("a read returns the machine's bytes and flags an external change", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    expect((await apply(h.workspace, applyBody())).status).toBe("applied");
    const first = await read(h.workspace, "a.txt");
    expect(first.status).toBe(200);
    expect(v.parse(ReadOk, first.body)).toStrictEqual({
      ok: true,
      path: "a.txt",
      version: versionOfText("one"),
      content: base64Of("one"),
      externalChange: false,
    });
    h.machine.seed("project/a.txt", "changed");
    const second = v.parse(ReadOk, (await read(h.workspace, "a.txt")).body);
    expect(second.version).toBe(versionOfText("changed"));
    expect(second.externalChange).toBe(true);
    const third = v.parse(ReadOk, (await read(h.workspace, "a.txt")).body);
    expect(third.externalChange).toBe(false);
  } finally {
    h.close();
  }
});

test("a read of a missing file is 404 and a missing machine is 503", async () => {
  const h = harness();
  try {
    // No lease has named a machine yet, so there is nowhere to read from.
    expect((await read(h.workspace, "missing.txt")).status).toBe(503);
    await acquire(h.workspace, leaseBody());
    expect((await read(h.workspace, "missing.txt")).status).toBe(404);
  } finally {
    h.close();
  }
  const offline = harness({ machine: false });
  try {
    expect((await read(offline.workspace, "a.txt")).status).toBe(503);
    // The lease is valid; the deployment simply has no machine binding.
    await acquire(offline.workspace, leaseBody());
    const response = await offline.workspace.fetch(post("/rpc/apply", applyBody()));
    expect(response.status).toBe(503);
    expect(v.parse(ProtocolFailure, await response.json()).code).toBe("unavailable");
  } finally {
    offline.close();
  }
});

test("a read while the machine is unreachable returns no content", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    expect((await apply(h.workspace, applyBody())).status).toBe("applied");
    h.machine.failNext();
    const result = await read(h.workspace, "a.txt");
    expect(result.status).toBe(503);
    expect(result.body).toStrictEqual({
      ok: false,
      code: "unavailable",
      message: "The machine did not answer.",
    });
  } finally {
    h.close();
  }
});
