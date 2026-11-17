import { expect, test } from "vitest";
import {
  checkpointRecordOf,
  initialMirror,
  nextMirror,
  parseCheckpointRecord,
  packUploadAnswer,
} from "./flow.ts";

const AT = Date.parse("2026-01-01T00:00:00.000Z");
const PACK_LIMIT = 64 * 1024 * 1024;

// Catches: a mirror recorded as pending for a run Artifacts can never take, so every such run
// would be retried into the same limit.
test("a run over the push limit is skipped with too_large", () => {
  expect(initialMirror(AT, 8, 4, PACK_LIMIT).status).toBe("pending");
  const overPack = initialMirror(AT, PACK_LIMIT + 1, 4, PACK_LIMIT);
  expect(overPack.status).toBe("skipped");
  expect(overPack.failure).toBe("too_large");
  const overBlob = initialMirror(AT, 8, 32 * 1024 * 1024 + 1, PACK_LIMIT);
  expect(overBlob.status).toBe("skipped");
});

// Catches: a token or a credential that found its way into the stored record through a field the
// caller passed; the schema is the contract's and drops what it does not name.
test("the record drops a field the contract does not name", () => {
  // SAFETY: the assertion is the test's subject: the object carries a key the parameter type does
  // not name, and `checkpointRecordOf` must drop it rather than store it.
  const fields = {
    runId: "run-1",
    ref: "refs/hns/checkpoints/run-1",
    commit: "a".repeat(40),
    packKey: "checkpoints/" + "a".repeat(40) + ".pack",
    objectCount: 3,
    packBytes: 8,
    maxBlobBytes: 4,
    mirror: initialMirror(AT, 8, 4, PACK_LIMIT),
    token: "secret",
  };
  // SAFETY: the assertion is the test's subject: `fields` carries a key the parameter type does
  // not name, and the function must drop it rather than store it.
  const record = checkpointRecordOf(fields as Parameters<typeof checkpointRecordOf>[0]);
  expect(Object.keys(record)).not.toContain("token");
  expect(parseCheckpointRecord(JSON.stringify(record))).toStrictEqual({
    runId: "run-1",
    ref: "refs/hns/checkpoints/run-1",
    commit: "a".repeat(40),
    packKey: "checkpoints/" + "a".repeat(40) + ".pack",
    objectCount: 3,
    packBytes: 8,
    maxBlobBytes: 4,
    mirror: { status: "pending", updatedAt: "2026-01-01T00:00:00.000Z" },
  });
});

// Catches: a mirror moving out of a terminal state, or a retry that does not return to pending.
test("the mirror follows the core transition table", () => {
  const pending = initialMirror(AT, 8, 4, PACK_LIMIT);
  expect(nextMirror(pending, { status: "mirrored" }, AT)?.status).toBe("mirrored");
  const failed = nextMirror(pending, { status: "failed", failure: "network" }, AT);
  expect(failed).toStrictEqual({
    status: "failed",
    failure: "network",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  // A retry moves failed back to pending; a terminal state does not move at all.
  if (failed === undefined) throw new Error("expected a failed state");
  expect(nextMirror(failed, { status: "pending" }, AT)?.status).toBe("pending");
  expect(nextMirror({ ...failed, status: "mirrored" }, { status: "failed" }, AT)).toBeUndefined();
  expect(nextMirror(pending, { status: "pending" }, AT)).toBeUndefined();
});

// Catches: a pack answer that does not say whether the key already had the pack, which is how a
// caller tells a retry (no write) from the first upload.
test("the pack answer names the key and whether it was written", () => {
  expect(
    packUploadAnswer({
      runId: "run-1",
      packKey: "checkpoints/c.pack",
      receivedBytes: 8,
      stored: true,
    }),
  ).toStrictEqual({
    ok: true,
    runId: "run-1",
    packKey: "checkpoints/c.pack",
    receivedBytes: 8,
    stored: true,
  });
});
