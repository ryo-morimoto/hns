import { expect, expectTypeOf, test } from "vitest";
import { CheckpointPackUploadResultSchema } from "@hns/core";
import type { CheckpointPackUploadResult } from "@hns/core";
import * as v from "valibot";
import {
  PACK_MAX_BYTES,
  PackTooLargeError,
  assertPackFits,
  type CheckpointPackTransport,
} from "./transport.ts";

const COMMIT = "0".repeat(40);

/**
 * A transport over an in-memory map, standing in for the R2 adapter the Workspace object gets.
 *
 * @remarks
 * It enforces the port's one failure: a pack over `maxBytes` is refused before it is stored, so a
 * test can see that nothing partial reached the store.
 */
class MemoryTransport implements CheckpointPackTransport {
  readonly maxBytes: number;
  readonly #packs = new Map<string, Uint8Array>();

  constructor(maxBytes: number = PACK_MAX_BYTES) {
    this.maxBytes = maxBytes;
  }

  /** What one key holds, or undefined when nothing was stored. */
  pack(runId: string): Uint8Array | undefined {
    return this.#packs.get(runId);
  }

  upload(runId: string, commit: string, bytes: Uint8Array): Promise<CheckpointPackUploadResult> {
    return Promise.resolve().then(() => {
      assertPackFits(bytes.length, this.maxBytes);
      this.#packs.set(runId, bytes);
      const result: CheckpointPackUploadResult = {
        runId,
        receivedBytes: bytes.length,
      };
      return result;
    });
  }

  /** The key a pack would be stored under, derived from its commit. */
  static key(commit: string): string {
    return "checkpoints/" + commit + ".pack";
  }
}

// Catches: the receiver accepting a number other than the checkpoint contract's, so the machine
// and the endpoint would refuse at different sizes.
test("the transport's limit is the contract's 64 MiB", () => {
  expect(PACK_MAX_BYTES).toBe(64 * 1024 * 1024);
  expectTypeOf<CheckpointPackTransport["maxBytes"]>().toEqualTypeOf<number>();
});

// Catches: a pack at the limit being refused, or one byte over being stored, which would leave a
// partial pack under a checkpoint key.
test("a pack exactly at the limit is stored and one byte more is not", async () => {
  const transport = new MemoryTransport(8);
  const atLimit = new Uint8Array(8);
  const stored = await transport.upload("run-1", COMMIT, atLimit);
  expect(v.parse(CheckpointPackUploadResultSchema, stored)).toStrictEqual({
    runId: "run-1",
    receivedBytes: 8,
  });
  expect(transport.pack("run-1")).toBe(atLimit);

  const over = new Uint8Array(9);
  await expect(transport.upload("run-2", COMMIT, over)).rejects.toBeInstanceOf(PackTooLargeError);
  expect(transport.pack("run-2")).toBeUndefined();
});

// Catches: the size check passing an over-limit pack, or naming a limit other than the one the
// endpoint reads.
test("the size check refuses only what is over its limit", () => {
  expect(() => {
    assertPackFits(16_777_216);
  }).not.toThrow();
  expect(() => {
    assertPackFits(64 * 1024 * 1024);
  }).not.toThrow();
  const error = (() => {
    try {
      assertPackFits(64 * 1024 * 1024 + 1);
      return undefined;
    } catch (cause) {
      return cause;
    }
  })();
  expect(error).toBeInstanceOf(PackTooLargeError);
  if (!(error instanceof PackTooLargeError)) throw new Error("expected a size refusal");
  expect(error.code).toBe("too_large");
  expect(error.offeredBytes).toBe(64 * 1024 * 1024 + 1);
  expect(error.limitBytes).toBe(64 * 1024 * 1024);
});
