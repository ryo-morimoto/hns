import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { CheckpointRecordSchema, MAX_CHECKPOINT_PACK_BYTES } from "@hns/core";
import { checkpointPackPath, parseCheckpointResult } from "../../../machine/src/wire.ts";
import type { CheckpointPackUpload } from "../../../machine/src/agent.ts";
import * as v from "valibot";
import { expect, test } from "vitest";
import { changeFile, gitRepository, indexPack } from "../../../machine/test/support/git.ts";
import { withAgent } from "../../../machine/test/support/machine.ts";
import type { MachineAnswer } from "../../../machine/test/support/machine.ts";
import type { PackBucket } from "../../src/checkpoint/transport.ts";
import { Workspace } from "../../src/do/workspace.ts";
import { deviceKeyFromSeed, sha256Hex, signDeviceHeaders } from "../../test/support/device.ts";
import { openSqliteState } from "../../test/support/sqlite.ts";

/**
 * One checkpoint through the whole path: a real machine agent, a real socket, real Ed25519
 * signatures, the real Workspace object, and the real SQLite under it.
 *
 * @remarks
 * The machine is `@hns/machine`'s actual agent, making checkpoints from a real git repository
 * and accepting the commit's pack on its signed route. Its pack sink stands in for the tunnel
 * that carries bytes to the Worker: it signs the pack with the machine's device key and hands it
 * to the Workspace object the way the edge face would. The bucket is in memory where R2 would be,
 * so the test can index the bytes R2 would hold with git and count the objects against the
 * machine's answer. The `machines` row is seeded the way enrollment (0148) will.
 *
 * What this proves that a fake cannot: the device key WebCrypto imports is the key Node signed
 * with, the signature covers the path and the pack's own hash, the object stores exactly the
 * bytes that arrived, and the record and watermark commit together.
 */

/** The machine's run id. */
const RUN_E2E = "run-e2e-1";

/** A bucket in memory that records writes, standing in for R2. */
interface FakeR2 extends PackBucket {
  readonly puts: string[];
  readonly objects: Map<string, Uint8Array>;
}

function fakeR2(): FakeR2 {
  const objects = new Map<string, Uint8Array>();
  const puts: string[] = [];
  return {
    puts,
    objects,
    put(key, value) {
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

/**
 * The pack git ships for one commit, which is what the machine's pack uploader sends.
 *
 * @remarks
 * The checkpoint operation answers metadata only (0244), so the bytes are the commit's own pack,
 * built by git exactly as the machine builds it. The agent accepts those bytes on the pack route.
 */
function packFor(repository: string, commit: string): Uint8Array {
  return new Uint8Array(
    execFileSync("git", ["-C", repository, "pack-objects", "--stdout", "--revs"], {
      input: commit + "\n",
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
}

/** The machine's checkpoint answer, read through its own parser. */
function checkpointOf(answer: MachineAnswer) {
  if (!answer.body.ok) throw new Error("the machine refused the checkpoint: " + answer.body.code);
  if (answer.body.op !== "checkpoint") throw new Error("expected a checkpoint answer");
  return parseCheckpointResult(answer.body.result);
}

/** The object's complete/prepare answer, parsed at the boundary. */
async function objectAnswer(response: Response) {
  return v.parse(
    v.object({ ok: v.literal(true), checkpoint: v.unknown(), watermark: v.number() }),
    JSON.parse(await response.text()),
  );
}

test(
  "a real machine signs the pack and the Workspace stores the same bytes",
  { timeout: 120_000 },
  async () => {
    const r2 = fakeR2();
    const opened = openSqliteState();
    const machine = await deviceKeyFromSeed(11);
    const sent: CheckpointPackUpload[] = [];
    /** What the Worker answered for each pack, in the order the machine sent them. */
    const accepted: { readonly receivedBytes: number }[] = [];
    let workspace: Workspace | undefined;
    /** Why the sink failed, when it did: the agent answers "internal" and hides the cause. */
    let sinkError: Error | undefined;

    /** The tunnel's half: sign the received pack with the device key and hand it to the object. */
    const forwardPack = async (upload: CheckpointPackUpload): Promise<void> => {
      sent.push(upload);
      const object = workspace;
      if (object === undefined) throw new Error("the Workspace object is not open yet");
      const bytes = new Uint8Array(upload.bytes);
      const path = checkpointPackPath(upload.runId);
      const headers = await signDeviceHeaders(
        { machineId: "machine-e2e", method: "POST", path, body: bytes },
        machine,
      );
      const response = await object.fetch(
        new Request("https://workspace.internal" + path, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/x-git-pack",
            "content-length": String(bytes.byteLength),
          },
          body: bytes,
        }),
      );
      const text = await response.text();
      if (response.status !== 200) throw new Error("the Worker refused the pack: " + text);
      // The Worker's own envelope (not the machine's): the object answers its RPC's shape.
      const body = v.parse(
        v.object({
          ok: v.literal(true),
          runId: v.string(),
          packKey: v.string(),
          receivedBytes: v.number(),
          stored: v.boolean(),
        }),
        JSON.parse(text),
      );
      accepted.push({ receivedBytes: body.receivedBytes });
    };

    try {
      await withAgent(
        async (paths) => {
          await gitRepository(paths.root);
          await changeFile(paths.root, "a.txt", "one\n");
        },
        async (fixture) => {
          // The device key enrollment stores, and the lease that names this machine.
          opened.sql(
            "CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, public_key BLOB NOT NULL)",
          );
          opened.sql(
            "INSERT OR REPLACE INTO machines (id, public_key) VALUES (?, ?)",
            fixture.machineId,
            new Uint8Array(machine.publicKey).buffer,
          );
          const object = new Workspace(opened.state, {
            now: () => Date.parse("2026-01-01T00:00:00.000Z"),
            packs: r2,
            // The object's own checkpoint call goes to the agent listening in this test.
            files: {
              write: () => Promise.reject(new Error("no write in this test")),
              read: () => Promise.reject(new Error("no read in this test")),
              checkpoint: async (request) => {
                const answer = await fixture.call({
                  body: JSON.stringify({ op: "checkpoint", runId: request.runId }),
                });
                if (!answer.body.ok) {
                  return {
                    ok: false,
                    failure: "unavailable",
                    detail: answer.body.code,
                    refusal: answer.body.code,
                  };
                }
                return { ok: true, result: parseCheckpointResult(answer.body.result) };
              },
            },
          });
          workspace = object;
          await object.fetch(
            new Request("https://workspace.internal/rpc/lease/acquire", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ workspaceId: "w1", machineId: fixture.machineId }),
            }),
          );

          // 1. prepare: the machine makes the checkpoint from the real repository, and the
          // object keeps its answer so the pack can be keyed by it.
          const direct = checkpointOf(
            await fixture.call({
              body: JSON.stringify({
                op: "checkpoint",
                runId: RUN_E2E,
                committedAt: 1_700_000_000,
              }),
            }),
          );
          const preparedResponse = await object.fetch(
            new Request("https://workspace.internal/rpc/checkpoint/prepare", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ workspaceId: "w1", runId: RUN_E2E }),
            }),
          );
          expect(preparedResponse.status, await preparedResponse.clone().text()).toBe(200);
          const prepared = await objectAnswer(preparedResponse);
          const preparedMeta = v.parse(
            v.object({ commit: v.string(), packKey: v.string(), packBytes: v.number() }),
            prepared.checkpoint,
          );
          expect(preparedMeta.commit).toBe(direct.commit);
          expect(preparedMeta.packKey).toBe(direct.packKey);
          expect(direct).toMatchObject({
            runId: RUN_E2E,
            ref: "refs/hns/checkpoints/" + RUN_E2E,
            created: true,
          });
          expect(direct.packKey).toBe("checkpoints/" + direct.commit + ".pack");
          expect(direct.packBytes).toBeGreaterThan(0);
          const pack = packFor(fixture.root, direct.commit);
          expect(pack.byteLength).toBe(direct.packBytes);
          // The commit's pack indexes to the objects the machine counted.
          expect((await indexPack(pack, fixture.base)).objectCount).toBe(direct.objectCount);

          // 2. pack: the machine accepts the commit's pack on its signed route; its sink signs it
          // with the device key and hands it to the object, which is where R2 would receive it.
          const packed = await fixture.call({
            body: "",
            path: checkpointPackPath(RUN_E2E),
            rawBody: { bytes: pack, contentType: "application/x-git-pack" },
          });
          expect(packed.status, sinkError?.stack ?? JSON.stringify(packed.body)).toBe(200);
          expect(accepted).toStrictEqual([{ receivedBytes: direct.packBytes }]);

          // 3. complete: the watermark and the record commit.
          const completed = await object.fetch(
            new Request("https://workspace.internal/rpc/checkpoint/complete", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ workspaceId: "w1", runId: RUN_E2E, throughSeq: 3 }),
            }),
          );
          expect(completed.status, await completed.clone().text()).toBe(200);
          const done = await objectAnswer(completed);
          const record = v.parse(CheckpointRecordSchema, done.checkpoint);
          expect(record).toMatchObject({
            runId: RUN_E2E,
            commit: direct.commit,
            packKey: direct.packKey,
            objectCount: direct.objectCount,
            packBytes: direct.packBytes,
            maxBlobBytes: direct.maxBlobBytes,
            mirror: { status: "pending" },
          });
          expect(done.watermark).toBe(3);

          // The store holds the bytes the machine sent, under the commit's key, once. Those bytes
          // are the commit's pack, which the test indexes with git.
          expect(r2.puts).toStrictEqual([direct.packKey]);
          const stored = new Uint8Array(r2.objects.get(record.packKey) ?? new Uint8Array(0));
          expect(sent).toHaveLength(1);
          expect(sha256Hex(stored)).toBe(
            sha256Hex(new Uint8Array(sent[0]?.bytes ?? new Uint8Array(0))),
          );
          expect(sha256Hex(stored)).toBe(sha256Hex(pack));
          expect((await indexPack(stored, fixture.base)).objectCount).toBe(direct.objectCount);
          // A git pack: "PACK", and a trailer that is the sha1 of the body before it.
          expect(new TextDecoder().decode(stored.subarray(0, 4))).toBe("PACK");
          expect(
            createHash("sha1")
              .update(stored.subarray(0, stored.byteLength - 20))
              .digest(),
          ).toStrictEqual(Buffer.from(stored.subarray(stored.byteLength - 20)));
          expect(MAX_CHECKPOINT_PACK_BYTES).toBeGreaterThan(direct.packBytes);
        },
        {
          machineId: "machine-e2e",
          onCheckpointPack: async (upload) => {
            try {
              await forwardPack(upload);
            } catch (error) {
              sinkError = error instanceof Error ? error : new Error(String(error));
              throw error;
            }
          },
        },
      );
    } finally {
      opened.close();
    }
  },
);
