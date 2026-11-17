import * as v from "valibot";
import { expect, expectTypeOf, test } from "vitest";
import { isoTimestamp } from "./codecs.ts";
import {
  ARTIFACTS_MAX_BLOB_BYTES,
  CHECKPOINT_PACK_CONTENT_TYPE,
  MIRROR_FAILURES,
  MIRROR_STATUSES,
  MIRROR_TRANSITIONS,
  MAX_CHECKPOINT_PACK_BYTES,
  CheckpointPackUploadResultSchema,
  CheckpointPrepareAnswerSchema,
  CheckpointPrepareResultSchema,
  CheckpointRecordSchema,
  MirrorStateSchema,
  canMirrorTransition,
  fitsArtifacts,
  fitsCheckpointPack,
  mirrorTargets,
} from "./checkpoint.ts";
import type {
  CheckpointPackUploadResult,
  CheckpointPrepareAnswer,
  CheckpointPrepareResult,
  CheckpointRecord,
  MirrorFailure,
  MirrorState,
  MirrorStatus,
  MirrorTarget,
} from "./checkpoint.ts";

const at = isoTimestamp("2026-11-18T00:00:00.000Z");

const mirror: MirrorState = { status: "pending", updatedAt: at };

const record: CheckpointRecord = {
  runId: "run-1",
  ref: "refs/hns/checkpoints/run-1",
  commit: "0".repeat(40),
  packKey: "checkpoints/" + "0".repeat(40) + ".pack",
  objectCount: 3,
  packBytes: 1024,
  maxBlobBytes: 512,
  mirror,
};

// Catches: a mirror status or failure that one writer names and another refuses, which would
// leave a stored record unreadable.
test("the mirror vocabulary is the closed set the contract names", () => {
  expect(MIRROR_STATUSES).toStrictEqual(["pending", "mirrored", "skipped", "failed"]);
  expect(MIRROR_FAILURES).toStrictEqual([
    "too_large",
    "unauthorized",
    "push_rejected",
    "network",
    "repo_unavailable",
    "unknown",
  ]);
});

// Catches: a status accepted by the schema that no state writes, or a failure recorded as a free
// string, which a reader would have to guess about.
test("an unknown mirror status or failure does not parse", () => {
  for (const status of MIRROR_STATUSES) {
    const parsed: MirrorState = v.parse(MirrorStateSchema, {
      status,
      updatedAt: at,
    });
    expect(parsed).toStrictEqual({ status, updatedAt: "2026-11-18T00:00:00.000Z" });
  }
  // A word outside the vocabulary is a ValiError at the boundary, not a status a store accepts.
  for (const status of ["mirrored\u0000", "complete", ""]) {
    expect(() =>
      v.parse(MirrorStateSchema, { status, updatedAt: "2026-11-18T00:00:00.000Z" }),
    ).toThrow(v.ValiError);
  }
  expect(() =>
    v.parse(MirrorStateSchema, {
      status: "failed",
      failure: "quota",
      updatedAt: at,
    }),
  ).toThrow(v.ValiError);
});

// Catches: the stored mirror state growing a credential field, which would persist a secret in
// the Workspace object.
test("the stored mirror state carries no credential", () => {
  expectTypeOf<MirrorState>().not.toHaveProperty("token");
  expectTypeOf<MirrorState>().not.toHaveProperty("remote");
  expect(Object.keys(v.parse(MirrorStateSchema, mirror)).sort()).toStrictEqual([
    "status",
    "updatedAt",
  ]);
});

// Catches: a checkpoint record that can hold a mirror target, which would put a push token in
// the value the Workspace object stores.
test("a checkpoint record cannot hold a mirror target", () => {
  expectTypeOf<CheckpointRecord>().not.toHaveProperty("token");
  expectTypeOf<CheckpointRecord>().not.toHaveProperty("remote");
  expectTypeOf<CheckpointRecord>().not.toHaveProperty("pack");
  expectTypeOf<CheckpointRecord["mirror"]>().toEqualTypeOf<MirrorState>();
  const target: MirrorTarget = {
    remote: "git.example/repo",
    token: "secret",
    ref: "refs/heads/hns/run/run-1",
    expiresAt: isoTimestamp("2026-11-18T00:15:00.000Z"),
  };
  // A token offered under a record's own key names is outside the schema's shape, so a parsed
  // record never carries one.
  const offered = { ...record, token: target.token, remote: target.remote };
  const parsed = v.parse(CheckpointRecordSchema, offered);
  expect(Object.keys(parsed).sort()).toStrictEqual([
    "commit",
    "maxBlobBytes",
    "mirror",
    "objectCount",
    "packBytes",
    "packKey",
    "ref",
    "runId",
  ]);
  expect(v.parse(CheckpointRecordSchema, record)).toStrictEqual(record);
});

// Catches: a migration that moves a mirror out of a terminal state, or that skips pending.
test("the transition table covers every status and only failed returns to pending", () => {
  expectTypeOf<keyof typeof MIRROR_TRANSITIONS>().toEqualTypeOf<MirrorStatus>();
  expect(Object.keys(MIRROR_TRANSITIONS).sort()).toStrictEqual([...MIRROR_STATUSES].sort());
  const statuses: readonly MirrorStatus[] = MIRROR_STATUSES;
  for (const status of statuses) {
    // Exhaustive by construction: a status without a row is a compile error and a missing key.
    const row: readonly MirrorStatus[] = MIRROR_TRANSITIONS[status];
    expect(row, status).toEqual(mirrorTargets(status));
    if (status === "mirrored" || status === "skipped") expect(row, status).toStrictEqual([]);
  }
  expect(new Set(MIRROR_TRANSITIONS.pending)).toStrictEqual(
    new Set<MirrorStatus>(["mirrored", "skipped", "failed"]),
  );
  expect([...MIRROR_TRANSITIONS.failed]).toStrictEqual(["pending"]);
});

// Catches: a retry recorded from a terminal state, or a mirror that "moves" to where it already is.
test("pending may fail and mirrored may not", () => {
  expect(canMirrorTransition("pending", "failed")).toBe(true);
  expect(canMirrorTransition("mirrored", "failed")).toBe(false);
  expect(canMirrorTransition("skipped", "pending")).toBe(false);
  expect(canMirrorTransition("failed", "pending")).toBe(true);
  expect(canMirrorTransition("failed", "mirrored")).toBe(false);
  expect(canMirrorTransition("pending", "pending")).toBe(false);
});

// Catches: the pack limit drifting from Artifacts' 64 MiB, or the media type becoming JSON.
test("the pack limit is 64 MiB and the media type names a git pack", () => {
  expect(MAX_CHECKPOINT_PACK_BYTES).toBe(64 * 1024 * 1024);
  expect(CHECKPOINT_PACK_CONTENT_TYPE).toBe("application/x-git-pack");
});

// Catches: an off-by-one at the pack boundary, where a pack of exactly the limit is refused or a
// pack one byte over is accepted.
test("a pack at the limit fits and one byte more does not", () => {
  expect(fitsCheckpointPack(MAX_CHECKPOINT_PACK_BYTES)).toBe(true);
  expect(fitsCheckpointPack(MAX_CHECKPOINT_PACK_BYTES - 1)).toBe(true);
  expect(fitsCheckpointPack(MAX_CHECKPOINT_PACK_BYTES + 1)).toBe(false);
});

// Catches: a prepare or upload answer that carries the pack itself in JSON, or one that forgets
// the sizes the mirror reads.
test("the prepare and upload answers are metadata only", () => {
  const prepare: CheckpointPrepareResult = {
    runId: record.runId,
    ref: record.ref,
    commit: record.commit,
    packKey: record.packKey,
    objectCount: record.objectCount,
    packBytes: record.packBytes,
    maxBlobBytes: record.maxBlobBytes,
    created: true,
  };
  expect(v.parse(CheckpointPrepareResultSchema, prepare)).toStrictEqual(prepare);
  expectTypeOf<CheckpointPrepareResult>().not.toHaveProperty("pack");
  // A body that offers the pack anyway loses it at the boundary instead of carrying it onward.
  expect(
    v.parse(CheckpointPrepareResultSchema, { ...prepare, pack: new Uint8Array([1]) }),
  ).toStrictEqual(prepare);

  const uploaded: CheckpointPackUploadResult = { runId: record.runId, receivedBytes: 1024 };
  expect(v.parse(CheckpointPackUploadResultSchema, uploaded)).toStrictEqual(uploaded);
  expectTypeOf<CheckpointPackUploadResult>().not.toHaveProperty("pack");
  expect(() =>
    v.parse(CheckpointPackUploadResultSchema, { ...uploaded, receivedBytes: -1 }),
  ).toThrow(v.ValiError);
  expect(() => v.parse(CheckpointPrepareResultSchema, { ...prepare, objectCount: 1.5 })).toThrow(
    v.ValiError,
  );
});

// Catches: the Artifacts file limit drifting from 32 MiB, or a run over it being offered a target
// the push would then be refused for.
test("a run fits Artifacts only when its pack and its largest blob do", () => {
  expect(ARTIFACTS_MAX_BLOB_BYTES).toBe(32 * 1024 * 1024);
  expect(fitsArtifacts(1024, ARTIFACTS_MAX_BLOB_BYTES)).toBe(true);
  expect(fitsArtifacts(1024, ARTIFACTS_MAX_BLOB_BYTES + 1)).toBe(false);
  expect(fitsArtifacts(MAX_CHECKPOINT_PACK_BYTES, 0)).toBe(true);
  expect(fitsArtifacts(MAX_CHECKPOINT_PACK_BYTES + 1, 0)).toBe(false);
});

// Catches: a prepare answer that loses the mirror target at the boundary (so the machine can never
// push), or one that accepts a ref Artifacts' binding cannot resolve.
test("a prepare answer carries the mirror target and nothing else it is offered", () => {
  const target: MirrorTarget = {
    remote: "https://git.example/git/ns/ws-1.git",
    token: "art_v2_x_secret",
    ref: "refs/heads/hns/run/run-1",
    expiresAt: isoTimestamp("2026-11-18T00:15:00.000Z"),
  };
  const answer: CheckpointPrepareAnswer = {
    checkpoint: {
      runId: record.runId,
      ref: record.ref,
      commit: record.commit,
      packKey: record.packKey,
      objectCount: record.objectCount,
      packBytes: record.packBytes,
      maxBlobBytes: record.maxBlobBytes,
      created: true,
    },
    watermark: 0,
    mirror: target,
  };
  const parsed = v.parse(CheckpointPrepareAnswerSchema, answer);
  expect(parsed.mirror).toStrictEqual(target);
  expect(Object.keys(parsed).sort()).toStrictEqual(["checkpoint", "mirror", "watermark"]);
  // Without a target the answer is still the contract's: the mirror is an optional field.
  // An answer without a target keeps the key as `undefined` (the schema's optional field), which
  // JSON omits on the wire; what matters is that it is not a target.
  expect(
    v.parse(CheckpointPrepareAnswerSchema, { ...answer, mirror: undefined }).mirror,
  ).toBeUndefined();
  for (const ref of ["refs/hns/checkpoints/run-1", "hns/run/run-1", "refs/tags/hns-run-1"]) {
    expect(() =>
      v.parse(CheckpointPrepareAnswerSchema, { ...answer, mirror: { ...target, ref } }),
    ).toThrow(v.ValiError);
  }
  expect(() =>
    v.parse(CheckpointPrepareAnswerSchema, { ...answer, mirror: { ...target, token: "" } }),
  ).toThrow(v.ValiError);
});

// Compile-time only: a failure code stays in the closed set, so a record cannot name a free word.
const failures: readonly MirrorFailure[] = MIRROR_FAILURES;
void failures;
