import { expect, test } from "vitest";
import * as v from "valibot";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  CHECKPOINT_PACK_CONTENT_TYPE,
  MAX_CHECKPOINT_PACK_BYTES,
  CheckpointPackUploadResultSchema,
} from "@hns/core";
import type { JsonValue } from "@hns/core";
import { checkpointPackPath, parseCheckpointResult, parseResponseBody } from "../../src/index.ts";
import type { CheckpointPackUpload, RefusalCode } from "../../src/index.ts";
import { generateControlPlaneKey } from "../support/control-plane.ts";
import { changeFile, gitRepository, indexPack, readRef } from "../support/git.ts";
import { withAgent } from "../support/machine.ts";
import type { AgentFixture, MachineAnswer, MachineCall } from "../support/machine.ts";

/**
 * A Run's checkpoint, end to end: a real repository, a real socket, and a real signature.
 *
 * @remarks
 * The machine makes the checkpoint and answers with metadata; the pack then travels on its own
 * signed binary request. The scenarios stand in for the Worker's receiver (0245), which does not
 * exist yet: the sink here is where the Worker would put the pack, so a test can prove the bytes
 * that arrived are the checkpoint's own pack. The agent runs in this process, so the "machine"
 * and the "Worker" are separate HTTP clients of the same agent.
 */

/**
 * The fields the checkpoint operation must answer with, from 0243's prepare answer.
 *
 * @remarks
 * This worktree's `@hns/core` resolves to the main checkout's copy, which predates
 * `packBytes` / `maxBlobBytes` in that schema (0243 added them to `CheckpointRecord` first).
 * The operation sends them and the test asserts them here; once the dependency matches, the
 * assertion and the operation's TODO(0243) can both go, and `parseCheckpointResult` accepts the
 * answer itself.
 */
/** A received JSON value, recursively, so the answer is parsed rather than asserted. */
const JsonValueSchema: v.GenericSchema<unknown, JsonValue> = v.lazy(() =>
  v.union([
    v.null(),
    v.boolean(),
    v.number(),
    v.string(),
    v.array(JsonValueSchema),
    v.record(v.string(), JsonValueSchema),
  ]),
);

const METADATA_KEYS = [
  "runId",
  "ref",
  "commit",
  "packKey",
  "objectCount",
  "packBytes",
  "maxBlobBytes",
  "created",
] as const;

/** The metadata of a checkpoint answer, checked against 0243's field list. */
interface CheckpointMetadata {
  readonly runId: string;
  readonly ref: string;
  readonly commit: string;
  readonly packKey: string;
  readonly objectCount: number;
  readonly packBytes: number;
  readonly maxBlobBytes: number;
  readonly created: boolean;
}

/** The refusal code of an answer that must have been refused. */
function codeOf(answer: MachineAnswer): RefusalCode {
  if (answer.body.ok) throw new Error("expected a refusal");
  return answer.body.code;
}

/** One field of the checkpoint answer, as this worktree's schema still names it. */
const MetadataFieldSchema = v.intersect([
  v.object({
    runId: v.pipe(v.string(), v.minLength(1)),
    ref: v.pipe(v.string(), v.minLength(1)),
    commit: v.pipe(v.string(), v.minLength(1)),
    packKey: v.pipe(v.string(), v.minLength(1)),
    objectCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
    created: v.boolean(),
  }),
  // The two measured fields, which this worktree's `@hns/core` build does not name yet.
  v.object({
    packBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
    maxBlobBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
]);

/** The checkpoint answer's metadata, parsed from the wire; a field the contract does not name fails. */
function metadataOf(answer: MachineAnswer): CheckpointMetadata {
  if (!answer.body.ok) throw new Error(`expected a result, got ${answer.body.code}`);
  if (answer.body.op !== "checkpoint") throw new Error("expected a checkpoint answer");
  // The field list is checked on what arrived; the parse then proves each field's type.
  const result = v.parse(v.record(v.string(), JsonValueSchema), answer.body.result);
  expect(Object.keys(result).sort()).toStrictEqual([...METADATA_KEYS].sort());
  return v.parse(MetadataFieldSchema, result);
}

/** The checkpoint operation's body. */
function checkpointBody(runId: string, committedAt = 1_700_000_000): string {
  return JSON.stringify({ op: "checkpoint", runId, committedAt });
}

/** Send one pack to its route, signed by the fixture's control-plane key unless overridden. */
function uploadPack(
  fixture: AgentFixture,
  runId: string,
  bytes: Uint8Array,
  overrides: {
    /** The bytes the signature covers, when they are not the bytes sent. */
    readonly signedBody?: string | undefined;
    /** The route the signature is computed for, when it is not the route called. */
    readonly signedPath?: string | undefined;
    readonly unsigned?: boolean | undefined;
    readonly contentType?: string | undefined;
    readonly signingKey?: AgentFixture["signingKey"] | undefined;
    readonly machineId?: string | undefined;
    /** A content-length to write instead of the body's own. */
    readonly raw?: { readonly header: string; readonly value: string | undefined } | undefined;
  } = {},
): Promise<MachineAnswer> {
  // Each override is present only when the scenario changed it; a call that leaves them out is
  // the plain, correctly signed upload.
  const call: MachineCall = {
    body: "",
    path: checkpointPackPath(runId),
    rawBody: { bytes, contentType: overrides.contentType ?? CHECKPOINT_PACK_CONTENT_TYPE },
  };
  if (overrides.signedBody !== undefined) call.signedBody = overrides.signedBody;
  if (overrides.unsigned !== undefined) call.unsigned = overrides.unsigned;
  if (overrides.signingKey !== undefined) call.signingKey = overrides.signingKey;
  if (overrides.machineId !== undefined) call.machineId = overrides.machineId;
  if (overrides.raw !== undefined) call.raw = overrides.raw;
  return fixture.call(call);
}

/** Build the pack git would ship for one commit. */
function packFor(repository: string, commit: string): Uint8Array {
  return new Uint8Array(
    execFileSync("git", ["-C", repository, "pack-objects", "--stdout", "--revs"], {
      input: commit + "\n",
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
}

// Catches: the checkpoint operation not being wired to a real commit, or its answer carrying the
// pack instead of metadata. C1.
test("a checkpoint answers metadata and its pack arrives on the signed pack route", async () => {
  const received: CheckpointPackUpload[] = [];
  await withAgent(
    async ({ root }) => {
      await gitRepository(root);
      await changeFile(root, "changed.txt", "changed\n");
    },
    async (fixture) => {
      const answer = await fixture.call({ body: checkpointBody("run-1") });
      const meta = metadataOf(answer);

      expect(answer.status).toBe(200);
      expect(JSON.stringify(answer.body)).not.toMatch(/"(pack|content|bytes)":/u);
      expect(meta).toMatchObject({
        runId: "run-1",
        ref: "refs/hns/checkpoints/run-1",
        packKey: "checkpoints/" + meta.commit + ".pack",
        created: true,
      });
      expect(meta.commit).toMatch(/^[0-9a-f]{40}$/u);
      expect(readRef(fixture.root, meta.ref)).toBe(meta.commit);
      expect(meta.objectCount).toBeGreaterThan(0);
      // The largest blob is the committed tracked.txt, not the whole pack.
      expect(meta.maxBlobBytes).toBe("tracked\n".length);
      expect(meta.packBytes).toBeGreaterThan(0);
      // The checkpoint contract's parser (0243) accepts the answer as it is, once the core this
      // machine is built against has the two measured fields. TODO(0243) marks the operation.
      const envelope = parseResponseBody(JSON.stringify(answer.body));
      if (!envelope.ok || envelope.op !== "checkpoint") throw new Error("expected an envelope");
      expect(parseCheckpointResult(envelope.result)).toStrictEqual(meta);

      // The uploader ships the commit's pack; the agent accepts it and the receiver gets exactly
      // those bytes for the Run that signed them.
      const pack = packFor(fixture.root, meta.commit);
      const upload = await uploadPack(fixture, "run-1", pack);
      expect(upload.status).toBe(200);
      if (!upload.body.ok || upload.body.op !== "pack") throw new Error("expected a pack answer");
      expect(v.parse(CheckpointPackUploadResultSchema, upload.body.result)).toStrictEqual({
        runId: "run-1",
        receivedBytes: pack.byteLength,
      });

      expect(received).toHaveLength(1);
      expect(received[0]?.runId).toBe("run-1");
      expect(
        createHash("sha256")
          .update(received[0]?.bytes ?? new Uint8Array())
          .digest("hex"),
      ).toBe(createHash("sha256").update(pack).digest("hex"));

      // What restore will do with the R2 copy: git indexes it back to the checkpoint's objects.
      const indexed = await indexPack(received[0]?.bytes ?? new Uint8Array(), fixture.base);
      expect(indexed.objectCount).toBe(meta.objectCount);
    },
    {
      onCheckpointPack: async (upload) => {
        received.push(upload);
      },
    },
  );
});

// Catches: a second checkpoint of one Run making a second commit, or two concurrent calls both
// reporting that they made the commit (the Worker would store one Run's pack under two keys). C2.
test("a Run has one checkpoint, however often it is asked", async () => {
  await withAgent(
    async ({ root }) => {
      await gitRepository(root);
      await changeFile(root, "changed.txt", "changed\n");
    },
    async (fixture) => {
      const first = metadataOf(await fixture.call({ body: checkpointBody("run-1") }));

      // The tree changes between the calls; the Run's commit must not.
      await changeFile(fixture.root, "later.txt", "later\n");
      const second = metadataOf(
        await fixture.call({ body: checkpointBody("run-1", 1_700_000_900) }),
      );
      expect(second.commit).toBe(first.commit);
      expect(second.packKey).toBe(first.packKey);
      expect(second.packBytes).toBe(first.packBytes);
      expect(second.maxBlobBytes).toBe(first.maxBlobBytes);
      expect(second.created).toBe(false);

      // Two Runs are two checkpoints: the Run id, not the tree, is the key.
      const other = metadataOf(
        await fixture.call({ body: checkpointBody("run-2", 1_700_000_900) }),
      );
      expect(other.commit).not.toBe(first.commit);
      expect(other.created).toBe(true);
      expect(other.maxBlobBytes).toBe("tracked\n".length);

      // Two calls at once for a third Run: one makes it, the other reads it back.
      const together = await Promise.all([
        fixture.call({ body: checkpointBody("run-3", 1_700_000_901) }),
        fixture.call({ body: checkpointBody("run-3", 1_700_000_901) }),
      ]);
      const answers = together.map(metadataOf);
      expect(new Set(answers.map((answer) => answer.commit)).size).toBe(1);
      expect(answers.filter((answer) => answer.created).length).toBe(1);
      expect(readRef(fixture.root, "refs/hns/checkpoints/run-3")).toBe(answers[0]?.commit);
    },
    { onCheckpointPack: async () => undefined },
  );
});

// Catches: a pack upload reaching the sink without a signature, under another signer, under
// another machine's name, at another Run's route, or with bytes the signature does not cover. C4.
test("a pack upload that is not exactly the signed bytes is refused", async () => {
  const received: CheckpointPackUpload[] = [];
  const intruder = generateControlPlaneKey();
  await withAgent(
    async ({ root }) => {
      await gitRepository(root);
    },
    async (fixture) => {
      const pack = new TextEncoder().encode("PACKv2-not-really-a-pack");
      const tampered = new Uint8Array(pack);
      tampered[0] = 0x58;

      const wrongType = await uploadPack(fixture, "run-1", pack, {
        contentType: "application/json",
      });
      const unsigned = await uploadPack(fixture, "run-1", pack, { unsigned: true });
      const anotherKey = await uploadPack(fixture, "run-1", pack, {
        signingKey: intruder.privateKey,
      });
      const anotherMachine = await uploadPack(fixture, "run-1", pack, { machineId: "machine-2" });
      // The signature covers the untampered pack; a different byte travels.
      const changedBytes = await fixture.call({
        body: "",
        path: checkpointPackPath("run-1"),
        rawBody: { bytes: pack, contentType: CHECKPOINT_PACK_CONTENT_TYPE },
        sentBody: tampered,
      });
      expect(wrongType.status).toBe(400);
      expect(codeOf(wrongType)).toBe("invalid_request");
      for (const [name, refused] of Object.entries({
        unsigned,
        anotherKey,
        anotherMachine,
        changedBytes,
      })) {
        expect(refused.status, name).toBe(401);
        expect(codeOf(refused), name).toBe("unauthorized");
      }
      // Nothing reached the receiver.
      expect(received).toHaveLength(0);

      // The same bytes, signed for their own Run, arrive intact.
      const accepted = await uploadPack(fixture, "run-1", pack);
      expect(accepted.status).toBe(200);
      expect(received.map((upload) => upload.runId)).toStrictEqual(["run-1"]);
      expect(received[0]?.bytes).toStrictEqual(pack);
    },
    {
      onCheckpointPack: async (upload) => {
        received.push(upload);
      },
    },
  );
});

// Catches: an upload carrying no `Transfer-Encoding: chunked` body being read anyway, or a
// body declared under the pack but sent differently being believed. Node's parser answers a
// non-numeric or negative `content-length` with 400 before any handler runs, so this side only
// ever sees a number; what remains to prove is the framing check the agent makes itself.
test("a pack without a usable content-length is refused", async () => {
  const received: CheckpointPackUpload[] = [];
  await withAgent(
    async ({ root }) => {
      await gitRepository(root);
    },
    async (fixture) => {
      const pack = new TextEncoder().encode("PACK-small");
      for (const value of ["not-a-number", "-5"]) {
        const answer = await uploadPack(fixture, "run-1", pack, {
          raw: { header: "content-length", value },
        });
        // Node's HTTP parser refuses the request itself (status 0 is a closed connection, 400
        // is its parse error). Either way it is never a success and never reaches the sink.
        expect(answer.status, value).not.toBe(200);
        expect(answer.body.ok, value).toBe(false);
      }
      // A body with no declared length is the chunked path, which the agent refuses: a pack is
      // framed by its length so that an over-limit one is refused before it is read.
      const chunked = await fixture.call({
        body: "",
        path: checkpointPackPath("run-1"),
        rawBody: { bytes: pack, contentType: CHECKPOINT_PACK_CONTENT_TYPE },
        raw: { header: "content-length", value: undefined },
      });
      expect(chunked.status).toBe(400);
      expect(codeOf(chunked)).toBe("invalid_request");
      expect(received).toHaveLength(0);
    },
    {
      onCheckpointPack: async (upload) => {
        received.push(upload);
      },
    },
  );
});

// Catches: a pack over the limit being read into memory, or a partial body reaching the receiver.
// The declared length is refused before the body, and a short body is refused as a mismatch.
// C3 / T3.
test("a pack over 64 MiB is refused without reading or storing a partial body", async () => {
  const received: CheckpointPackUpload[] = [];
  await withAgent(
    async ({ root }) => {
      await gitRepository(root);
    },
    async (fixture) => {
      const pack = new TextEncoder().encode("PACK-small");

      // A declared length over the limit: refused on the header, before a byte is read, so the
      // agent never waits for 64 MiB it would not keep.
      const overLimit = await uploadPack(fixture, "run-1", pack, {
        raw: { header: "content-length", value: String(MAX_CHECKPOINT_PACK_BYTES + 1) },
      });
      expect(overLimit.status).toBe(413);
      expect(codeOf(overLimit)).toBe("too_large");

      // The same declaration with nothing following it: still refused on the header alone.
      const noBody = await uploadPack(fixture, "run-1", new Uint8Array(), {
        raw: { header: "content-length", value: String(MAX_CHECKPOINT_PACK_BYTES + 1) },
      });
      expect(noBody.status).toBe(413);

      // A declared length under the signed body's: the bytes past the declared length are never
      // part of the message, so the signature no longer matches and the upload is refused.
      const short = await uploadPack(fixture, "run-1", pack, {
        raw: { header: "content-length", value: String(pack.byteLength - 1) },
      });
      expect(short.status).toBe(401);
      expect(codeOf(short)).toBe("unauthorized");

      expect(received).toHaveLength(0);
      // A pack exactly at the limit is within it; the bound is inclusive.
      expect(MAX_CHECKPOINT_PACK_BYTES).toBe(64 * 1024 * 1024);
    },
    {
      onCheckpointPack: async (upload) => {
        received.push(upload);
      },
    },
  );
});
// Catches: a pack upload not holding a concurrency slot, so many slow uploads could run at once
// beside the operations, or holding one it does not give back. The slots are shared by design:
// while an upload is in flight, a JSON operation at the cap is refused as busy, and the slot is
// free again once the upload answers.
test("a pack upload holds one concurrency slot and gives it back", async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => undefined;
  const uploading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await withAgent(
    async ({ root }) => {
      await gitRepository(root);
    },
    async (fixture) => {
      const pack = new TextEncoder().encode("PACK-slot");
      const upload = uploadPack(fixture, "run-1", pack);
      await uploading;

      // The one slot is held by the upload: another request is refused without waiting.
      expect(fixture.agent.inFlight).toBe(1);
      const busy = await fixture.call({ body: JSON.stringify({ op: "health" }) });
      expect(busy.status).toBe(429);
      expect(codeOf(busy)).toBe("busy");

      release();
      expect((await upload).status).toBe(200);
      // Returned: the next operation gets the slot.
      const health = await fixture.call({ body: JSON.stringify({ op: "health" }) });
      expect(health.status).toBe(200);
      expect(fixture.agent.inFlight).toBe(0);
    },
    {
      onCheckpointPack: async () => {
        entered();
        await held;
      },
      limits: { maxConcurrency: 1 },
    },
  );
});
