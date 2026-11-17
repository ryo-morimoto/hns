import { checkpointPackKey } from "@hns/workspace/objects";
import { expect, expectTypeOf, test } from "vitest";
import {
  PACK_MAX_BYTES,
  PackRejectedError,
  PackTooLargeError,
  R2PackTransport,
  assertPackFits,
  type CheckpointPackTransport,
  type PackBucket,
} from "./transport.ts";

const COMMIT = "0".repeat(40);

/** A bucket in memory that records every write, the way a fake R2 does. */
interface FakeBucket extends PackBucket {
  readonly puts: string[];
}

function fakeBucket(): FakeBucket {
  const objects = new Map<string, Uint8Array>();
  const puts: string[] = [];
  return {
    puts,
    put(key, value) {
      puts.push(key);
      objects.set(key, value);
      return Promise.resolve({ key, size: value.byteLength });
    },
    head(key) {
      const value = objects.get(key);
      return Promise.resolve(value === undefined ? null : { key, size: value.byteLength });
    },
  };
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
  const bucket = fakeBucket();
  const transport = new R2PackTransport(bucket, 8);
  const atLimit = new Uint8Array(8);
  const stored = await transport.upload("run-1", checkpointPackKey(COMMIT), atLimit);
  expect(stored).toStrictEqual({ status: "stored", packKey: checkpointPackKey(COMMIT) });
  expect(bucket.puts).toStrictEqual([checkpointPackKey(COMMIT)]);
  expect(await transport.has(checkpointPackKey(COMMIT))).toBe(true);

  const over = new Uint8Array(9);
  await expect(
    transport.upload("run-2", checkpointPackKey("1".repeat(40)), over),
  ).rejects.toBeInstanceOf(PackTooLargeError);
  expect(bucket.puts).toHaveLength(1);
});

// Catches: a retried upload writing the same key again (a second Class A write), or replacing the
// pack restore already depends on.
test("a second upload of the same key writes nothing", async () => {
  const bucket = fakeBucket();
  const transport = new R2PackTransport(bucket);
  const key = checkpointPackKey(COMMIT);
  const first = await transport.upload("run-1", key, new Uint8Array([1, 2, 3]));
  const second = await transport.upload("run-1", key, new Uint8Array([1, 2, 3]));
  expect(first.status).toBe("stored");
  expect(second.status).toBe("present");
  expect(bucket.puts).toStrictEqual([key]);
});

// Catches: an empty pack being stored, which restore would index as a broken checkpoint.
test("an empty pack is refused and never reaches the store", async () => {
  const bucket = fakeBucket();
  const transport = new R2PackTransport(bucket);
  await expect(
    transport.upload("run-1", checkpointPackKey(COMMIT), new Uint8Array(0)),
  ).rejects.toBeInstanceOf(PackRejectedError);
  expect(bucket.puts).toStrictEqual([]);
});

// Catches: a store refusal read as success, which would acknowledge a checkpoint with no pack.
test("a refused write is an error, never an accepted pack", async () => {
  const bucket: PackBucket = {
    put: () => Promise.resolve(null),
    head: () => Promise.resolve(null),
  };
  const transport = new R2PackTransport(bucket);
  await expect(
    transport.upload("run-1", checkpointPackKey(COMMIT), new Uint8Array([1])),
  ).rejects.toThrow(/refused/u);
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
