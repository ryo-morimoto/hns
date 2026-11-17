import {
  ARTIFACTS_MAX_BLOB_BYTES,
  CheckpointPrepareAnswerSchema,
  CheckpointPrepareResultSchema,
  CheckpointRecordSchema,
  IsoTimestampSchema,
  LEASE_REFUSALS,
  MAX_CHECKPOINT_PACK_BYTES,
  operationId,
  type CheckpointPrepareResult,
  type LeaseRefusal,
} from "@hns/core";
import { mirrorRef, reviewSourceFor } from "@hns/workspace/mirror";
import { ARTIFACTS_REMOTE_LIMITS, artifactsRepoName } from "../artifacts/repos.ts";
import {
  artifactError,
  fakeArtifactsBinding,
  type FakeArtifactsBinding,
} from "../../test/support/artifacts.ts";
import { checkpointPackKey } from "@hns/workspace/objects";
import type { JournalOutcomeEntry } from "@hns/store";
import { expect, test } from "vitest";
import * as v from "valibot";
import {
  BODY_HASH_HEADER,
  deviceKeyFromSeed,
  sha256Hex,
  signDeviceHeaders,
} from "../../test/support/device.ts";
import { base64Of, fakeMachine, versionOfText } from "../../test/support/machine.ts";
import type { PackBucket } from "../checkpoint/transport.ts";
import { openSqliteState } from "../../test/support/sqlite.ts";
import { Journal } from "./journal.ts";
import { Workspace, type WorkspaceBindings } from "./workspace.ts";

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

/** A bucket in memory that records every write, the way the object store does. */
interface FakePackBucket extends PackBucket {
  readonly puts: string[];
  /** Make the next put fail as an unavailable store would (the bucket throws). */
  failNextPut(): void;
  /** The bytes under a key, or undefined. */
  bytes(key: string): Uint8Array | undefined;
}

function fakePackBucket(): FakePackBucket {
  const objects = new Map<string, Uint8Array>();
  const puts: string[] = [];
  let failPut = false;
  return {
    puts,
    failNextPut() {
      failPut = true;
    },
    bytes(key) {
      return objects.get(key);
    },
    put(key, value) {
      if (failPut) {
        failPut = false;
        return Promise.reject(new Error("the object store is unavailable"));
      }
      puts.push(key);
      objects.set(key, new Uint8Array(value));
      return Promise.resolve({ key, size: value.byteLength });
    },
    head(key) {
      const value = objects.get(key);
      return Promise.resolve(value === undefined ? null : { key, size: value.byteLength });
    },
  };
}

interface Harness {
  readonly workspace: Workspace;
  readonly journal: Journal;
  readonly machine: ReturnType<typeof fakeMachine>;
  readonly packs: FakePackBucket;
  advance(ms: number): void;
  close(): void;
}

function harness(options: { readonly machine?: boolean } = {}): Harness {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const opened = openSqliteState();
  const machine = fakeMachine();
  const packs = fakePackBucket();
  const settings = { now: () => nowMs, leaseTtlMs: 1_000, packs };
  const workspace =
    options.machine === false
      ? new Workspace(opened.state, settings)
      : new Workspace(opened.state, { ...settings, files: machine });
  const journal = new Journal(opened.state.storage, { now: () => nowMs });
  return {
    workspace,
    journal,
    machine,
    packs,
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
    // A reused id is a refusal, not a version conflict: nothing about the file changed.
    expect(response.status).toBe(400);
    expect(v.parse(Denied, await response.json()).code).toBe("denied");
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
/** Count the journal rows of one kind. */
async function journalCounts(h: Harness): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const entry of (await h.journal.read()).entries) {
    counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  }
  return counts;
}

// Catches: a read for a sibling project reaching the machine before the binding check.
test("a read for another project root is refused before the machine", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    expect((await apply(h.workspace, applyBody({ projectRoot: "one" }))).status).toBe("applied");
    const readsBefore = h.machine.reads.length;
    const response = await h.workspace.fetch(get("/rpc/read?projectRoot=two&path=a.txt"));
    expect(response.status).toBe(400);
    expect(v.parse(ProtocolFailure, await response.json()).code).toBe("invalid_request");
    expect(h.machine.reads).toHaveLength(readsBefore);
    expect((await read(h.workspace, "a.txt", "one")).status).toBe(200);
  } finally {
    h.close();
  }
});

// Catches: a failed read claiming the project, so the first real write is refused.
test("a failed read does not bind the project", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    expect((await read(h.workspace, "missing.txt", "one")).status).toBe(404);
    const applied = await apply(h.workspace, applyBody({ projectRoot: "two" }));
    expect(applied.status).toBe("applied");
  } finally {
    h.close();
  }
});

// Catches: a refused or unknown write claiming the project before it applied anything.
test("a refused write does not claim the project", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    h.machine.denyNext("path_denied");
    const denied = await h.workspace.fetch(post("/rpc/apply", applyBody({ projectRoot: "one" })));
    expect(denied.status).toBe(400);
    const applied = await apply(
      h.workspace,
      applyBody({ operationId: "op-2", projectRoot: "two" }),
    );
    expect(applied.status).toBe("applied");
  } finally {
    h.close();
  }
});

test("an unknown write and a lease refusal do not claim the project", async () => {
  const h = harness();
  try {
    // No lease yet: the refusal happens before anything could bind.
    const refused = await h.workspace.fetch(post("/rpc/apply", applyBody({ projectRoot: "one" })));
    expect(await refusalOf(refused)).toBe("lease_not_held");
    await acquire(h.workspace, leaseBody());
    h.machine.failNext();
    const unknown = await apply(h.workspace, applyBody({ projectRoot: "one" }));
    expect(unknown.status).toBe("unknown");
    const applied = await apply(
      h.workspace,
      applyBody({ operationId: "op-2", projectRoot: "two" }),
    );
    expect(applied.status).toBe("applied");
  } finally {
    h.close();
  }
});

// Catches: an applied outcome, its version, and its event landing in three transactions, so
// simultaneous retries append the event twice.
test("simultaneous retries append one intent, one outcome, and one event", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    const responses = await Promise.all([
      h.workspace.fetch(post("/rpc/apply", applyBody())),
      h.workspace.fetch(post("/rpc/apply", applyBody())),
    ]);
    for (const response of responses) {
      expect(v.parse(ApplyOk, await response.json()).result.status).toBe("applied");
    }
    expect(await journalCounts(h)).toStrictEqual({ intent: 1, outcome: 1, event: 1 });
  } finally {
    h.close();
  }
});

// Catches: an outcome recorded without its version or event never being repaired, or the
// repair appending a second event on every retry.
test("a settled applied outcome repairs the version and event once", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    const content = base64Of("one");
    await h.journal.appendIntent({
      operationId: operationId("op-1"),
      path: "a.txt",
      expectedVersion: "absent",
      body: new TextEncoder().encode("one"),
    });
    await h.journal.appendOutcome({
      path: "a.txt",
      result: {
        status: "applied",
        operationId: operationId("op-1"),
        version: versionOfText("one"),
      },
    });
    expect(await journalCounts(h)).toStrictEqual({ intent: 1, outcome: 1 });
    const repaired = await h.workspace.fetch(post("/rpc/apply", applyBody({ content })));
    expect(v.parse(ApplyOk, await repaired.json()).result.status).toBe("applied");
    expect(await journalCounts(h)).toStrictEqual({ intent: 1, outcome: 1, event: 1 });
    const retried = await h.workspace.fetch(post("/rpc/apply", applyBody({ content })));
    expect(v.parse(ApplyOk, await retried.json()).result.status).toBe("applied");
    expect(await journalCounts(h)).toStrictEqual({ intent: 1, outcome: 1, event: 1 });
  } finally {
    h.close();
  }
});

// Catches: a file beyond the read bound reported as missing.
test("a read beyond the bound is a 413, not a 404", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    expect((await apply(h.workspace, applyBody())).status).toBe("applied");
    h.machine.tooLargeNext();
    const result = await read(h.workspace, "a.txt");
    expect(result.status).toBe(413);
    expect(v.parse(ProtocolFailure, result.body).code).toBe("payload_too_large");
  } finally {
    h.close();
  }
});
// Catches: two concurrent first writes with different projects both reaching the machine, so
// the loser's bind rolls its outcome back and leaves a pending intent that stops the watermark.
test("concurrent first writes with different project roots bind once", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    const responses = await Promise.all([
      h.workspace.fetch(
        post("/rpc/apply", applyBody({ operationId: "op-a", projectRoot: "one", path: "a.txt" })),
      ),
      h.workspace.fetch(
        post("/rpc/apply", applyBody({ operationId: "op-b", projectRoot: "two", path: "b.txt" })),
      ),
    ]);
    expect(responses.map((response) => response.status).sort()).toStrictEqual([200, 400]);
    expect(h.machine.writes).toHaveLength(1);
    expect(await journalCounts(h)).toStrictEqual({ intent: 1, outcome: 1, event: 1 });
    // No attempt is left pending, so a checkpoint can truncate the journal.
    const written = await h.journal.writeWatermark(100);
    expect(written.watermark.throughSeq).toBe(100);
  } finally {
    h.close();
  }
});

// Catches: the same hole between a first read and a first write of another project.
test("a concurrent first read and write bind once", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    const responses = await Promise.all([
      h.workspace.fetch(post("/rpc/apply", applyBody({ projectRoot: "one", path: "a.txt" }))),
      h.workspace.fetch(get("/rpc/read?projectRoot=two&path=b.txt")),
    ]);
    expect(responses.map((response) => response.status).sort()).toStrictEqual([200, 400]);
    expect(h.machine.writes.length + h.machine.reads.length).toBe(1);
    const written = await h.journal.writeWatermark(100);
    expect(written.watermark.throughSeq).toBe(100);
  } finally {
    h.close();
  }
});

// Catches: a too-large write recorded as a plain denial instead of a 413.
test("a too-large write is a 413 denial", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    h.machine.tooLargeNext();
    const response = await h.workspace.fetch(post("/rpc/apply", applyBody()));
    expect(response.status).toBe(413);
    expect(v.parse(ProtocolFailure, await response.json()).code).toBe("payload_too_large");
    // The outcome is recorded, so the retry returns the same answer and the watermark can pass.
    const retry = await h.workspace.fetch(post("/rpc/apply", applyBody()));
    expect(retry.status).toBe(413);
    expect(await journalCounts(h)).toStrictEqual({ intent: 1, outcome: 1 });
  } finally {
    h.close();
  }
});
// Catches: a method mismatch answering 400 because the failure was named invalid_request; the
// status the RPC answered with before the code table is 405 (read from 236aa2e).
test("a method mismatch is a 405 with method_not_allowed", async () => {
  const h = harness();
  try {
    await acquire(h.workspace, leaseBody());
    const cases = [
      ["PUT /rpc/apply", "https://workspace/rpc/apply", { method: "PUT" }],
      ["POST /rpc/read", "https://workspace/rpc/read?projectRoot=&path=a.txt", { method: "POST" }],
      ["GET /rpc/journal/watermark", "https://workspace/rpc/journal/watermark", {}],
      ["GET /rpc/lease/acquire", "https://workspace/rpc/lease/acquire", {}],
    ] as const;
    for (const [name, url, init] of cases) {
      const response = await h.workspace.fetch(new Request(url, init));
      expect(response.status, name).toBe(405);
      expect(v.parse(ProtocolFailure, await response.json()).code, name).toBe("method_not_allowed");
    }
  } finally {
    h.close();
  }
});

// Catches: a non-JSON body refused with a status other than the 415 the RPC answered before the
// table (the body read names `unsupported_media_type`; the status stays 415).
test("a body of the wrong media type is a 415", async () => {
  const h = harness();
  try {
    const response = await h.workspace.fetch(
      new Request("https://workspace/rpc/lease/acquire", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "not json",
      }),
    );
    expect(response.status).toBe(415);
    expect(v.parse(ProtocolFailure, await response.json()).code).toBe("unsupported_media_type");
  } finally {
    h.close();
  }
});

// Catches: an oversized body refused with a status other than the 413 the RPC answered before
// the table (the body read names `payload_too_large`; the status stays 413).
test("an oversized body is a 413", async () => {
  const h = harness();
  try {
    const response = await h.workspace.fetch(
      new Request("https://workspace/rpc/lease/acquire", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(70 * 1024 * 1024) },
        body: JSON.stringify({ workspaceId: "w1" }),
      }),
    );
    expect(response.status).toBe(413);
    expect(v.parse(ProtocolFailure, await response.json()).code).toBe("payload_too_large");
  } finally {
    h.close();
  }
});

/** The checkpoint RPC answer: the prepare result, or the record complete wrote. */
const CheckpointOk = v.object({
  ok: v.literal(true),
  checkpoint: v.unknown(),
  watermark: v.number(),
});
/** The mirror RPC answer: the updated record. */
const MirrorOk = v.object({ ok: v.literal(true), checkpoint: v.unknown() });
const PackOk = v.object({
  ok: v.literal(true),
  runId: v.string(),
  packKey: v.string(),
  receivedBytes: v.number(),
  stored: v.boolean(),
});

/** A row as the object's SQL binding returns it. */
type SqlValue = ArrayBuffer | string | number | null;

/** A row's SQL runner, as the test state exposes it for setup. */
type SqlRunner = (
  query: string,
  ...bindings: readonly (ArrayBuffer | string | number | null)[]
) => void;

/**
 * Seed the machine registry's table the way enrollment would.
 *
 * @param sql - The test state's SQL runner.
 * @param machineId - The machine the key belongs to.
 * @param publicKey - The raw 32-byte Ed25519 device key.
 *
 * @remarks
 * The `machines` table is the machine registry's (0148, not landed here). The object reads it
 * when it exists and refuses every pack when it does not, so this is the only setup the
 * checkpoint path needs and its absence is a case the tests cover too.
 */
function enrollMachine(sql: SqlRunner, machineId: string, publicKey: Uint8Array): void {
  sql("CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, public_key BLOB NOT NULL)");
  const bytes = new Uint8Array(publicKey);
  sql("INSERT OR REPLACE INTO machines (id, public_key) VALUES (?, ?)", machineId, bytes.buffer);
}

/** Prepare one Run and return the machine's answer. */
async function prepare(h: Harness, runId: string, workspaceId = "w1") {
  const response = await h.workspace.fetch(post("/rpc/checkpoint/prepare", { workspaceId, runId }));
  expect(response.status, await response.clone().text()).toBe(200);
  return v.parse(CheckpointOk, await response.json());
}

/** Build the signed pack request the machine forwards. */
async function packRequest(
  runId: string,
  bytes: Uint8Array,
  key: Awaited<ReturnType<typeof deviceKeyFromSeed>>,
  overrides: { readonly bodyHash?: string; readonly contentType?: string } = {},
): Promise<Request> {
  const path = "/rpc/checkpoint/" + runId + "/pack";
  const headers = await signDeviceHeaders(
    { machineId: "m1", method: "POST", path, body: bytes },
    key,
  );
  if (overrides.bodyHash !== undefined) headers[BODY_HASH_HEADER] = overrides.bodyHash;
  return new Request("https://workspace" + path, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": overrides.contentType ?? "application/x-git-pack",
      "content-length": String(bytes.byteLength),
    },
    body: new Uint8Array(bytes),
  });
}

/** A harness whose object has the machine enrolled, so a signed pack can verify. */
interface CheckpointHarness {
  readonly workspace: Workspace;
  readonly journal: Journal;
  readonly machine: ReturnType<typeof fakeMachine>;
  readonly packs: FakePackBucket;
  readonly sql: SqlRunner;
  readonly key: Awaited<ReturnType<typeof deviceKeyFromSeed>>;
  /** Read the object's real tables, for an assertion about what was stored. */
  rows(query: string, ...bindings: readonly (string | number)[]): Record<string, SqlValue>[];
  advance(ms: number): void;
  readonly close: () => void;
}

async function harnessWithEnrolledMachine(
  key?: Awaited<ReturnType<typeof deviceKeyFromSeed>>,
): Promise<CheckpointHarness> {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const opened = openSqliteState();
  const machine = fakeMachine();
  const packs = fakePackBucket();
  const workspace = new Workspace(opened.state, {
    now: () => nowMs,
    leaseTtlMs: 1_000,
    packs,
    files: machine,
  });
  const journal = new Journal(opened.state.storage, { now: () => nowMs });
  const deviceKey = key ?? (await deviceKeyFromSeed(7));
  enrollMachine(opened.sql, "m1", deviceKey.publicKey);
  return {
    workspace,
    journal,
    machine,
    packs,
    sql: opened.sql,
    key: deviceKey,
    rows: opened.rows,
    advance(ms) {
      nowMs += ms;
    },
    close: opened.close,
  };
}

/** A deterministic pack of `size` bytes: distinct bytes, so a byte-identity check means something. */
function packBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 7 + 3) % 251;
  return bytes;
}

/** The pack key a prepare answer names; the test asserts it rather than computes it. */
function packKeyOf(prepare: CheckpointPrepareResult): string {
  return checkpointPackKey(prepare.commit);
}

/** How many checkpoint rows a Run has (0 or 1 by the table's primary key). */
function checkpointRows(h: CheckpointHarness, runId: string): number {
  return h.rows("SELECT run_id FROM checkpoint_run WHERE run_id = ?", runId).length;
}

/** The stored record's text for a Run, or null when complete has not written it. */
function checkpointRecordOfRun(h: CheckpointHarness, runId: string): string | null {
  const row = h.rows("SELECT record FROM checkpoint_run WHERE run_id = ?", runId)[0];
  if (row === undefined || row.record === undefined || row.record === null) return null;
  return String(row.record);
}

// C1: Catches a checkpoint acknowledged without its pack in the store, or the watermark moving
// before the record that says what it covers.
test("prepare, pack, and complete put the pack in the store and move the watermark", async () => {
  const h = await harnessWithEnrolledMachine();
  try {
    const { workspace, machine, packs, key } = h;
    await acquire(workspace, leaseBody());
    const prepared = await prepare(h, "run-1");
    const checkpoint = v.parse(CheckpointPrepareResultSchema, prepared.checkpoint);
    expect(checkpoint).toMatchObject({ runId: "run-1", created: true, packBytes: 8 });
    expect(machine.checkpoints).toStrictEqual(["run-1"]);
    expect(packKeyOf(checkpoint)).toBe(checkpointPackKey(checkpoint.commit));
    expect((await h.journal.read()).entries.length).toBe(0);

    const bytes = packBytes(8);
    const uploaded = await workspace.fetch(await packRequest("run-1", bytes, key));
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    const answer = v.parse(PackOk, await uploaded.json());
    expect(answer).toStrictEqual({
      ok: true,
      runId: "run-1",
      packKey: checkpointPackKey(checkpoint.commit),
      receivedBytes: 8,
      stored: true,
    });
    // The bytes in the store are the bytes that were sent, byte for byte.
    expect([...(packs.bytes(checkpointPackKey(checkpoint.commit)) ?? [])]).toStrictEqual([
      ...bytes,
    ]);

    const completed = await workspace.fetch(
      post("/rpc/checkpoint/complete", { workspaceId: "w1", runId: "run-1", throughSeq: 5 }),
    );
    expect(completed.status, await completed.clone().text()).toBe(200);
    const done = v.parse(CheckpointOk, await completed.json());
    expect(done.watermark).toBe(5);
    const record = v.parse(CheckpointRecordSchema, done.checkpoint);
    expect(record).toMatchObject({
      runId: "run-1",
      commit: checkpoint.commit,
      packKey: checkpointPackKey(checkpoint.commit),
      packBytes: 8,
      maxBlobBytes: 4,
      mirror: { status: "pending" },
    });
    expect(h.journal.watermark()?.throughSeq).toBe(5);
  } finally {
    h.close();
  }
});

// C2: Catches a retried upload writing the pack a second time (a second Class A write) or
// answering with a different key.
test("a retried pack upload stores nothing a second time", async () => {
  const h = await harnessWithEnrolledMachine();
  try {
    const { workspace, packs, key } = h;
    await acquire(workspace, leaseBody());
    const checkpoint = v.parse(
      CheckpointPrepareResultSchema,
      (await prepare(h, "run-1")).checkpoint,
    );
    const bytes = packBytes(8);
    const first = await workspace.fetch(await packRequest("run-1", bytes, key));
    const second = await workspace.fetch(await packRequest("run-1", bytes, key));
    expect(v.parse(PackOk, await first.json()).stored).toBe(true);
    const again = v.parse(PackOk, await second.json());
    expect(again.stored).toBe(false);
    expect(again.packKey).toBe(checkpointPackKey(checkpoint.commit));
    expect(packs.puts).toStrictEqual([checkpointPackKey(checkpoint.commit)]);
  } finally {
    h.close();
  }
});

// C3: Catches a pack stored without a valid device signature, over the limit, or whose bytes are
// not the ones the machine signed (the three ways a different pack could reach R2).
test("an unsigned, oversized, or altered pack is refused and never stored", async () => {
  const h = await harnessWithEnrolledMachine();
  try {
    const { workspace, packs, key } = h;
    await acquire(workspace, leaseBody());
    await prepare(h, "run-1");
    const bytes = packBytes(8);

    // Unsigned: the same request without the six signed headers.
    const unsigned = await workspace.fetch(
      new Request("https://workspace/rpc/checkpoint/run-1/pack", {
        method: "POST",
        headers: { "content-type": "application/x-git-pack", "content-length": "8" },
        body: new Uint8Array(bytes),
      }),
    );
    expect(unsigned.status).toBe(401);

    // Signed by a key the machine is not enrolled with.
    const intruder = await deviceKeyFromSeed(99);
    const forged = await workspace.fetch(await packRequest("run-1", bytes, intruder));
    expect(forged.status).toBe(401);

    // The bytes are the signed ones but the machine's repeated hash names other bytes: a header
    // changed in transit must not make the object store a pack the signature does not cover.
    const altered = await workspace.fetch(
      await packRequest("run-1", bytes, key, { bodyHash: sha256Hex(new Uint8Array(8)) }),
    );
    expect(altered.status).toBe(401);

    // Over the limit: the declared length is refused before the body is read.
    const over = await workspace.fetch(
      new Request("https://workspace/rpc/checkpoint/run-1/pack", {
        method: "POST",
        headers: {
          "content-type": "application/x-git-pack",
          "content-length": String(MAX_CHECKPOINT_PACK_BYTES + 1),
        },
        body: "",
      }),
    );
    expect(over.status).toBe(413);
    expect(v.parse(ProtocolFailure, await over.json()).code).toBe("payload_too_large");
    expect(packs.puts).toStrictEqual([]);
  } finally {
    h.close();
  }
});

// C4: Catches complete acknowledging a checkpoint whose pack never reached the store, or a
// watermark left moved with no record after the store failed.
test("complete without the pack is refused, and the watermark does not move", async () => {
  const h = await harnessWithEnrolledMachine();
  try {
    const { workspace } = h;
    await acquire(workspace, leaseBody());
    await prepare(h, "run-1");
    const refused = await workspace.fetch(
      post("/rpc/checkpoint/complete", { workspaceId: "w1", runId: "run-1", throughSeq: 5 }),
    );
    expect(refused.status).toBe(409);
    expect(v.parse(ProtocolFailure, await refused.json()).code).toBe("conflict");
    expect(h.journal.watermark()).toBeUndefined();
    expect(await checkpointRecordOfRun(h, "run-1")).toBeNull();
  } finally {
    h.close();
  }
});

// C4 (retry): Catches a retried complete writing a second record or a second truncation.
test("a retried complete answers the recorded checkpoint", async () => {
  const h = await harnessWithEnrolledMachine();
  try {
    const { workspace, key } = h;
    await acquire(workspace, leaseBody());
    await prepare(h, "run-1");
    await workspace.fetch(await packRequest("run-1", packBytes(8), key));
    const first = v.parse(
      CheckpointOk,
      await (
        await workspace.fetch(
          post("/rpc/checkpoint/complete", { workspaceId: "w1", runId: "run-1", throughSeq: 5 }),
        )
      ).json(),
    );
    const retried = v.parse(
      CheckpointOk,
      await (
        await workspace.fetch(
          post("/rpc/checkpoint/complete", { workspaceId: "w1", runId: "run-1", throughSeq: 5 }),
        )
      ).json(),
    );
    expect(retried.checkpoint).toStrictEqual(first.checkpoint);
    expect(retried.watermark).toBe(5);
    expect(await checkpointRows(h, "run-1")).toBe(1);
  } finally {
    h.close();
  }
});

// Catches a machine that did not make a checkpoint being answered as if it had: prepare must
// return a typed failure and write nothing.
test("a failed machine checkpoint is a refusal and records no checkpoint", async () => {
  const h = await harnessWithEnrolledMachine();
  try {
    const { workspace, machine } = h;
    await acquire(workspace, leaseBody());
    machine.checkpointNext("fail");
    const response = await workspace.fetch(
      post("/rpc/checkpoint/prepare", { workspaceId: "w1", runId: "run-1" }),
    );
    expect(response.status).toBe(503);
    expect(v.parse(ProtocolFailure, await response.json()).code).toBe("unavailable");
    expect(await checkpointRows(h, "run-1")).toBe(0);
  } finally {
    h.close();
  }
});

// Catches the mirror's failure reaching the checkpoint's answer: a push that failed is recorded
// on the checkpoint, and the checkpoint stays answered.
test("a failed mirror is recorded and does not fail the checkpoint", async () => {
  const h = await harnessWithMirror();
  try {
    const { workspace } = h;
    const record0 = await checkpointOnce(h, "run-1");
    // The binding's log holds the commit: a `mirrored` report is confirmed against it.
    h.artifacts?.push(artifactsRepoName("w1"), mirrorRef("run-1"), record0.commit);
    const moved = await workspace.fetch(
      post("/rpc/checkpoint/mirror", {
        workspaceId: "w1",
        runId: "run-1",
        status: "failed",
        failure: "network",
      }),
    );
    expect(moved.status, await moved.clone().text()).toBe(200);
    const record = v.parse(
      CheckpointRecordSchema,
      v.parse(MirrorOk, await moved.json()).checkpoint,
    );
    expect(record.mirror).toMatchObject({ status: "failed", failure: "network" });
    // A retry moves failed back to pending; the checkpoint's answer was never touched.
    const retried = await workspace.fetch(
      post("/rpc/checkpoint/mirror", { workspaceId: "w1", runId: "run-1", status: "pending" }),
    );
    expect(retried.status, await retried.clone().text()).toBe(200);
    const mirrored = await workspace.fetch(
      post("/rpc/checkpoint/mirror", { workspaceId: "w1", runId: "run-1", status: "mirrored" }),
    );
    expect(mirrored.status, await mirrored.clone().text()).toBe(200);
    // Mirrored is terminal: the table refuses a move back to failed.
    const again = await workspace.fetch(
      post("/rpc/checkpoint/mirror", { workspaceId: "w1", runId: "run-1", status: "failed" }),
    );
    expect(again.status).toBe(409);
    expect(h.journal.watermark()?.throughSeq).toBe(5);
  } finally {
    h.close();
  }
});
// C4: Catches a complete that writes the record and then leaves the watermark untouched when the
// truncation refuses (a pending intent below the seq): the record would claim a checkpoint whose
// Journal was not moved, and restore could not tell which entries it covers.
test("a complete whose watermark cannot move leaves no record", async () => {
  const h = await harnessWithEnrolledMachine();
  try {
    const { workspace, key, machine } = h;
    await acquire(workspace, leaseBody());
    // An intent with no outcome is the evidence a watermark may not pass (INV-04): the machine
    // answers nothing, so the write stays pending.
    machine.failNext();
    // An undecided write is recorded as `unknown`, which is settled evidence: it does not block
    // the watermark. A pending intent is made by a crash between the intent and the outcome, so
    // the test writes that shape directly.
    const pendingWrite = await workspace.fetch(
      post("/rpc/apply", applyBody({ path: "pending.txt" })),
    );
    expect(pendingWrite.status).toBe(200);
    const pending = h.journal.appendIntent({
      operationId: operationId("op-pending"),
      path: "pending.txt",
      expectedVersion: "absent",
    });
    expect((await pending).status).toBe("appended");
    await prepare(h, "run-1");
    const bytes = packBytes(8);
    const uploaded = await workspace.fetch(await packRequest("run-1", bytes, key));
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    const refused = await workspace.fetch(
      post("/rpc/checkpoint/complete", { workspaceId: "w1", runId: "run-1", throughSeq: 100 }),
    );
    expect(refused.status).toBe(409);
    expect(h.journal.watermark()).toBeUndefined();
    expect(await checkpointRecordOfRun(h, "run-1")).toBeNull();
  } finally {
    h.close();
  }
});
/**
 * The mirror's C-series tests (0246).
 *
 * The C1 / C4 / C5 decisions are the Workspace object's, so they run against the real object with
 * a fake `ARTIFACTS`; the push itself is the machine's and is exercised over a real git remote in
 * `packages/server/test/integration/mirror.test.ts`.
 */

/**
 * A checkpoint harness whose object has the Artifacts binding and the switch set.
 *
 * `artifacts` is optional because the unbound deployment is the same harness minus the fake; a
 * test that asserts what the binding was asked reads it where it supplied one.
 */
interface MirrorHarness extends CheckpointHarness {
  readonly artifacts?: FakeArtifactsBinding | undefined;
}

async function harnessWithMirror(
  options: {
    readonly enabled?: boolean;
    readonly binding?: FakeArtifactsBinding;
  } = {},
): Promise<MirrorHarness> {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const opened = openSqliteState();
  const machine = fakeMachine();
  const packs = fakePackBucket();
  const artifacts = options.binding ?? fakeArtifactsBinding({ now: () => nowMs });
  const workspace = new Workspace(opened.state, {
    now: () => nowMs,
    leaseTtlMs: 1_000,
    packs,
    files: machine,
    artifacts,
    artifactsMirror: options.enabled ?? true,
  });
  const journal = new Journal(opened.state.storage, { now: () => nowMs });
  const deviceKey = await deviceKeyFromSeed(7);
  enrollMachine(opened.sql, "m1", deviceKey.publicKey);
  return {
    workspace,
    journal,
    machine,
    packs,
    artifacts,
    sql: opened.sql,
    key: deviceKey,
    rows: opened.rows,
    advance(ms) {
      nowMs += ms;
    },
    close: opened.close,
  };
}

/**
 * The prepare answer as the contract spells it, mirror included.
 *
 * The object answers a checkpoint from its lease holder or its recorded machine, so a prepare
 * acquires the lease first when the test has not: that is the order a Run takes in production.
 */
async function preparedAnswer(h: MirrorHarness, runId = "run-1") {
  const held = await h.workspace.fetch(post("/rpc/lease/acquire", leaseBody()));
  if (!held.ok) expect(v.parse(Refused, await held.json()).code).toBe("lease_not_held");
  const response = await h.workspace.fetch(
    post("/rpc/checkpoint/prepare", { workspaceId: "w1", runId }),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return v.parse(CheckpointPrepareAnswerSchema, await response.json());
}

/** Run one checkpoint to complete and return the record. */
async function checkpointOnce(h: MirrorHarness, runId = "run-1") {
  const answer = await preparedAnswer(h, runId);
  const uploaded = await h.workspace.fetch(
    await packRequest(runId, packBytes(answer.checkpoint.packBytes), h.key),
  );
  expect(uploaded.status, await uploaded.clone().text()).toBe(200);
  const completed = await h.workspace.fetch(
    post("/rpc/checkpoint/complete", { workspaceId: "w1", runId, throughSeq: 5 }),
  );
  expect(completed.status, await completed.clone().text()).toBe(200);
  return v.parse(CheckpointRecordSchema, v.parse(CheckpointOk, await completed.json()).checkpoint);
}
// C1: Catches a prepare that offers no target (the machine can never push), a name outside
// Artifacts' rule, a repository not created, or a token that lives longer than the push.
test("a prepare issues a target through the codec and creates the repository once", async () => {
  const h = await harnessWithMirror();
  try {
    const answer = await preparedAnswer(h);
    expect(answer.mirror, "a prepare within the limits carries a target").toBeDefined();
    const target = answer.mirror;
    if (target === undefined) return;
    const name = artifactsRepoName("w1");
    expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/u);
    expect(h.artifacts?.creates).toStrictEqual([name]);
    expect(target.remote).toBe("https://git.example/git/ns/" + name + ".git");
    expect(target.ref).toBe("refs/heads/hns/run/run-1");
    expect(target.token.length).toBeGreaterThan(0);
    // 900 seconds of slack from the object's clock, not the repository's default day.
    expect(target.expiresAt).toBe("2026-01-01T00:15:00.000Z");

    // A second prepare of the same Run does not create a second repository.
    await preparedAnswer(h);
    expect(h.artifacts?.creates).toHaveLength(1);
  } finally {
    h.close();
  }
});

// C5: Catches a token reaching the stored record or the Journal, or the checkpoint's own answer
// being rewritten by the mirror.
test("the token is in the prepare answer and nowhere that is stored", async () => {
  const h = await harnessWithMirror();
  try {
    const answer = await preparedAnswer(h);
    const token = answer.mirror?.token;
    expect(token).toBeDefined();
    const record = await checkpointOnce(h);
    expect(record.mirror.status).toBe("pending");
    const stored = checkpointRecordOfRun(h, "run-1");
    expect(stored).not.toBeNull();
    expect(stored).not.toContain(String(token));
    const rows = h.rows("SELECT run_id, prepare, record FROM checkpoint_run");
    expect(JSON.stringify(rows)).not.toContain(String(token));
    const journal = JSON.stringify((await h.journal.read()).entries);
    expect(journal).not.toContain(String(token));
    // The record's own shape is the contract's: a token offered under a record key is dropped.
    expect(Object.keys(v.parse(CheckpointRecordSchema, { ...record, token })).sort()).toStrictEqual(
      ["commit", "maxBlobBytes", "mirror", "objectCount", "packBytes", "packKey", "ref", "runId"],
    );
  } finally {
    h.close();
  }
});

// C4: Catches a run over Artifacts' per-file limit being offered a target and pushed, or being
// recorded `pending` so its review would wait for a push that can never fit.
test("a run over the 32 MiB file limit is skipped and its review falls back to the machine", async () => {
  const h = await harnessWithMirror();
  try {
    await acquire(h.workspace, leaseBody());
    h.machine.checkpointNext({
      commit: "1".repeat(40),
      maxBlobBytes: ARTIFACTS_MAX_BLOB_BYTES + 1,
      packBytes: 8,
    });
    const answer = await preparedAnswer(h);
    expect(answer.mirror).toBeUndefined();
    const uploaded = await h.workspace.fetch(await packRequest("run-1", packBytes(8), h.key));
    expect(uploaded.status).toBe(200);
    const completed = await h.workspace.fetch(
      post("/rpc/checkpoint/complete", { workspaceId: "w1", runId: "run-1", throughSeq: 5 }),
    );
    const record = v.parse(
      CheckpointRecordSchema,
      v.parse(CheckpointOk, await completed.json()).checkpoint,
    );
    expect(record.mirror).toStrictEqual({
      status: "skipped",
      failure: "too_large",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(reviewSourceFor(record.mirror)).toBe("machine");
    // At the limit exactly, the run is offered a target: the bound is inclusive.
    h.machine.checkpointNext({
      commit: "2".repeat(40),
      maxBlobBytes: ARTIFACTS_MAX_BLOB_BYTES,
      packBytes: 8,
    });
    expect((await preparedAnswer(h, "run-2")).mirror).toBeDefined();
    expect(reviewSourceFor({ status: "mirrored", updatedAt: record.mirror.updatedAt })).toBe(
      "artifacts",
    );
  } finally {
    h.close();
  }
});

// C4: Catches a pack over the 64 MiB push limit going to Artifacts; the contract's pack limit is
// the checkpoint's and the mirror's one number.
test("a run over the 64 MiB pack limit is skipped", async () => {
  const h = await harnessWithMirror();
  try {
    await acquire(h.workspace, leaseBody());
    h.machine.checkpointNext({
      commit: "3".repeat(40),
      maxBlobBytes: 1024,
      packBytes: MAX_CHECKPOINT_PACK_BYTES + 1,
    });
    expect((await preparedAnswer(h)).mirror).toBeUndefined();
    expect(ARTIFACTS_REMOTE_LIMITS.packBytes).toBe(MAX_CHECKPOINT_PACK_BYTES);
  } finally {
    h.close();
  }
});

// C2 (Worker half): Catches a `mirrored` report the Worker records without asking the binding's
// log — a machine's word is not the proof, and a failed confirmation must land as a failure.
test("a mirrored report the binding's log cannot confirm is refused and recorded failed", async () => {
  const h = await harnessWithMirror();
  try {
    const record = await checkpointOnce(h);
    const report = (status: string) =>
      h.workspace.fetch(
        post("/rpc/checkpoint/mirror", { workspaceId: "w1", runId: "run-1", status }),
      );
    // The binding holds the commit at another ref, not at the Run's: nothing confirms it.
    h.artifacts?.push(artifactsRepoName("w1"), mirrorRef("run-2"), record.commit);
    const refused = await report("mirrored");
    expect(refused.status, await refused.clone().text()).toBe(409);
    const stored = v.parse(
      CheckpointRecordSchema,
      JSON.parse(String(checkpointRecordOfRun(h, "run-1"))),
    );
    // The ref is absent (the commit was put at another Run's ref): the push did not land.
    expect(stored.mirror).toMatchObject({ status: "failed", failure: "push_rejected" });
    // With the commit at the ref the report is accepted, and the record says mirrored.
    h.artifacts?.push(artifactsRepoName("w1"), mirrorRef("run-1"), record.commit);
    expect((await report("pending")).status).toBe(200);
    const mirrored = await report("mirrored");
    expect(mirrored.status, await mirrored.clone().text()).toBe(200);
    expect(
      v.parse(CheckpointRecordSchema, v.parse(MirrorOk, await mirrored.json()).checkpoint).mirror
        .status,
    ).toBe("mirrored");
  } finally {
    h.close();
  }
});

// C3 / kill switch: Catches a switch that is ignored (a target offered with the mirror off), or a
// prepare that fails when Artifacts is unbound.
test("the kill switch and a missing binding both answer no target and still checkpoint", async () => {
  const switchedOff = await harnessWithMirror({ enabled: false });
  const unbound = await harnessWithMirrorWithoutBinding();
  for (const h of [switchedOff, unbound]) {
    try {
      const answer = await preparedAnswer(h);
      expect(answer.mirror).toBeUndefined();
      const record = await checkpointOnce(h);
      expect(record.mirror.status).toBe("pending");
      expect(reviewSourceFor(record.mirror)).toBe("machine");
    } finally {
      h.close();
    }
  }
  // The switch is read before the binding is touched: no repository was even looked for.
  expect(switchedOff.artifacts?.creates).toStrictEqual([]);
  expect(switchedOff.artifacts?.tokens).toStrictEqual([]);
});

// C3 / kill switch (deploy path): Catches a deploy switch that is ignored or misread — the object
// is built from the bindings alone, as the Worker builds it, so the text values are what decide.
test("ARTIFACTS_MIRROR decides the mirror: off, on, and anything else", async () => {
  for (const [value, mirrors] of [
    ["off", false],
    [undefined, false],
    ["ON", false],
    ["on", true],
  ] as const) {
    const h = await harnessFromBindings(value === undefined ? {} : { ARTIFACTS_MIRROR: value });
    try {
      const answer = await preparedAnswer(h);
      expect(answer.mirror === undefined, String(value)).toBe(!mirrors);
      expect(h.artifacts.creates.length > 0, String(value)).toBe(mirrors);
      const record = await checkpointOnce(h);
      expect(record.mirror.status, String(value)).toBe("pending");
    } finally {
      h.close();
    }
  }
});

/**
 * A harness constructed the way the deploy constructs the object: bindings only, no options.
 *
 * @param bindings - The environment's `ARTIFACTS_MIRROR` (the kill switch).
 *
 * @remarks
 * The option form (`artifactsMirror`) is a test seam; production reads the text binding, so this
 * is the only place the switch's own value is exercised. A test that only used the option would
 * pass with a deploy switch that is ignored.
 */
async function harnessFromBindings(
  bindings: WorkspaceBindings,
): Promise<CheckpointHarness & { readonly artifacts: FakeArtifactsBinding }> {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const opened = openSqliteState();
  const machine = fakeMachine();
  const packs = fakePackBucket();
  const artifacts = fakeArtifactsBinding({ now: () => nowMs });
  const workspace = new Workspace(opened.state, {
    now: () => nowMs,
    leaseTtlMs: 1_000,
    packs,
    files: machine,
    ...bindings,
    ARTIFACTS: artifacts,
  });
  const journal = new Journal(opened.state.storage, { now: () => nowMs });
  const deviceKey = await deviceKeyFromSeed(7);
  enrollMachine(opened.sql, "m1", deviceKey.publicKey);
  return {
    workspace,
    journal,
    machine,
    packs,
    artifacts,
    sql: opened.sql,
    key: deviceKey,
    rows: opened.rows,
    advance(ms) {
      nowMs += ms;
    },
    close: opened.close,
  };
}

/** A harness with the switch on and no `ARTIFACTS` binding, as a deployment without Artifacts. */
async function harnessWithMirrorWithoutBinding(): Promise<CheckpointHarness> {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const opened = openSqliteState();
  const machine = fakeMachine();
  const packs = fakePackBucket();
  const workspace = new Workspace(opened.state, {
    now: () => nowMs,
    leaseTtlMs: 1_000,
    packs,
    files: machine,
    artifactsMirror: true,
  });
  const journal = new Journal(opened.state.storage, { now: () => nowMs });
  const deviceKey = await deviceKeyFromSeed(7);
  enrollMachine(opened.sql, "m1", deviceKey.publicKey);
  return {
    workspace,
    journal,
    machine,
    packs,
    sql: opened.sql,
    key: deviceKey,
    rows: opened.rows,
    advance(ms) {
      nowMs += ms;
    },
    close: opened.close,
  };
}

// C3: Catches a binding failure reaching the checkpoint's answer, or being rounded to a target.
test("an Artifacts failure answers no target and the checkpoint still completes", async () => {
  const now = (): number => Date.parse("2026-01-01T00:00:00.000Z");
  const binding = fakeArtifactsBinding({ now });
  binding.failNextCreate(artifactError("UPSTREAM_UNAVAILABLE"));
  const h = await harnessWithMirror({ binding });
  try {
    const answer = await preparedAnswer(h);
    expect(answer.mirror).toBeUndefined();
    const record = await checkpointOnce(h);
    expect(record.mirror.status).toBe("pending");
    // The next prepare reuses nothing it could not create: it creates and offers a target.
    expect((await preparedAnswer(h, "run-2")).mirror).toBeDefined();
  } finally {
    h.close();
  }
});

// C3: Catches a mirror report that is not idempotent (a resent "mirrored" after a lost answer
// answered as a conflict), or one that rewrites why a failed mirror failed.
test("a resent mirror report is the recorded state, and a different failure is refused", async () => {
  const h = await harnessWithMirror();
  try {
    const record0 = await checkpointOnce(h);
    h.artifacts?.push(artifactsRepoName("w1"), mirrorRef("run-1"), record0.commit);
    const report = (status: string, failure?: string) =>
      h.workspace.fetch(
        post("/rpc/checkpoint/mirror", { workspaceId: "w1", runId: "run-1", status, failure }),
      );
    const failed = await report("failed", "push_rejected");
    expect(failed.status).toBe(200);
    const again = await report("failed", "push_rejected");
    expect(again.status, await again.clone().text()).toBe(200);
    const otherReason = await report("failed", "network");
    expect(otherReason.status).toBe(409);
    // A retry only leaves failed for pending: mirrored is written from there, as the push path does.
    expect((await report("pending")).status).toBe(200);
    const mirrored = await report("mirrored");
    expect(mirrored.status, await mirrored.clone().text()).toBe(200);
    const resent = await report("mirrored");
    expect(resent.status, await resent.clone().text()).toBe(200);
    const last = await report("skipped");
    expect(last.status).toBe(409);
  } finally {
    h.close();
  }
});

// NB3 / acceptance: Catches a `failed` mirror that can never become `mirrored` when its push had
// in fact landed. The row is the object's own SQLite (the same shape D1 hands it), so this is
// "recorded failed, then settled by a re-send" end to end at the storage layer: the failed row is
// written, read back, and moved by the re-check; the binding's own failure reason is kept.
//
// Catches too a confirmation that writes "unknown" for a binding that said `network`: the row
// must say why it failed, so an operator (and 0249's metrics) can tell a broken binding from a
// push that did not land.
test("a mirror recorded failed is settled to mirrored by a re-send that finds the commit", async () => {
  const h = await harnessWithMirror();
  try {
    const record = await checkpointOnce(h);
    const repo = artifactsRepoName("w1");
    const ref = mirrorRef("run-1");
    const report = (status: string) =>
      h.workspace.fetch(
        post("/rpc/checkpoint/mirror", { workspaceId: "w1", runId: "run-1", status }),
      );
    const storedMirror = () =>
      v.parse(CheckpointRecordSchema, JSON.parse(String(checkpointRecordOfRun(h, "run-1")))).mirror;

    // The push landed on the remote, but the binding could not answer when the Worker confirmed:
    // the row records the binding's own reason, not a guess.
    h.artifacts?.failNextGet(artifactError("UPSTREAM_UNAVAILABLE"));
    const unconfirmed = await report("mirrored");
    expect(unconfirmed.status).toBe(409);
    expect(storedMirror()).toMatchObject({ status: "failed", failure: "network" });

    // The binding answers again, and its history has the commit: the re-send settles the row.
    h.artifacts?.push(repo, ref, record.commit);
    const settled = await report("mirrored");
    expect(settled.status, await settled.clone().text()).toBe(200);
    expect(storedMirror()).toStrictEqual({
      status: "mirrored",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    // A second re-send is the recorded state, and mirrored is terminal for the table.
    expect((await report("mirrored")).status).toBe(200);
    expect((await report("failed")).status).toBe(409);
  } finally {
    h.close();
  }
});

// NB3 / low 5: Catches a ref that is absent being recorded as a binding failure (or the reverse):
// the two are different answers, and the record keeps the one that happened.
test("an absent ref is a failed push and a broken binding keeps its own reason", async () => {
  const h = await harnessWithMirror();
  try {
    const record = await checkpointOnce(h);
    const report = (status: string) =>
      h.workspace.fetch(
        post("/rpc/checkpoint/mirror", { workspaceId: "w1", runId: "run-1", status }),
      );
    const storedMirror = () =>
      v.parse(CheckpointRecordSchema, JSON.parse(String(checkpointRecordOfRun(h, "run-1")))).mirror;

    // Nothing is at the ref: the mirror is `push_rejected` — the push did not land.
    expect((await report("mirrored")).status).toBe(409);
    expect(storedMirror()).toMatchObject({ status: "failed", failure: "push_rejected" });

    // The binding is unavailable: the row says `network`, not `push_rejected`.
    h.artifacts?.failNextGet(artifactError("UPSTREAM_UNAVAILABLE"));
    expect((await report("pending")).status).toBe(200);
    expect((await report("mirrored")).status).toBe(409);
    expect(storedMirror()).toMatchObject({ status: "failed", failure: "network" });

    // A repository that is not there at all is `repo_unavailable`: the binding answered `NOT_FOUND`.
    h.artifacts?.failNextGet(artifactError("NOT_FOUND"));
    expect((await report("pending")).status).toBe(200);
    expect((await report("mirrored")).status).toBe(409);
    expect(storedMirror()).toMatchObject({ status: "failed", failure: "repo_unavailable" });

    // And with the commit at the ref it settles, whatever earlier failure the row held.
    h.artifacts?.push(artifactsRepoName("w1"), mirrorRef("run-1"), record.commit);
    expect((await report("mirrored")).status).toBe(200);
    expect(storedMirror()).toMatchObject({ status: "mirrored" });
  } finally {
    h.close();
  }
});
