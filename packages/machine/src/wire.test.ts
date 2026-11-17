import { expect, test } from "vitest";
import type { IncomingHttpHeaders } from "node:http";
import * as v from "valibot";
import {
  CHECKPOINT_PACK_CONTENT_TYPE,
  MAX_CHECKPOINT_PACK_BYTES,
  SIGNED_HEADER_BY_FIELD,
  fitsCheckpointPack,
} from "@hns/core";
import type { CheckpointPrepareResult, JsonValue } from "@hns/core";
import { MachineRefusal } from "./refusal.ts";
import {
  MACHINE_PACK_CONTENT_TYPE,
  PACK_RESPONSE_OP,
  checkpointPackPath,
  checkpointPackRunId,
  parseCheckpointPackResult,
  parseCheckpointResult,
  parseHealthResult,
  parseListResult,
  parseOperation,
  parseReadResult,
  parseResponseBody,
  parseSignedHeaders,
  parseStatResult,
} from "./wire.ts";

/** A received JSON value, recursively, so untrusted text is parsed rather than asserted. */
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

const SIGNATURE = "A".repeat(86);

const headers = (overrides: Record<string, string | string[]> = {}): IncomingHttpHeaders => ({
  "x-hns-machine": "machine-1",
  "x-hns-connection": "connection-1",
  "x-hns-seq": "1",
  "x-hns-timestamp": "1700000000000",
  "x-hns-nonce": "nonce-0123456789abcdef",
  "x-hns-signature": SIGNATURE,
  ...overrides,
});

test("the signed headers parse to their wire spelling", () => {
  expect(parseSignedHeaders(headers())).toStrictEqual({
    machineId: "machine-1",
    connection: "connection-1",
    seq: "1",
    timestamp: "1700000000000",
    nonce: "nonce-0123456789abcdef",
    signature: SIGNATURE,
  });
});

// Catches: the machine parsing a private copy of the signed fields, which would drift from the
// headers core's signer builds (one renamed header and every request is refused).
test("every signed field is read from the header core names for it", () => {
  const parsed = parseSignedHeaders(headers());
  expect(Object.keys(parsed)).toStrictEqual(Object.keys(SIGNED_HEADER_BY_FIELD));
  for (const header of Object.values(SIGNED_HEADER_BY_FIELD)) {
    expect(Object.values(parsed)).toContain(headers()[header]);
  }
  // The correlation-id rule the machine id and connection follow is core's, not a copy.
  expect(() => parseSignedHeaders(headers({ "x-hns-machine": "has space" }))).toThrow(
    MachineRefusal,
  );
  expect(() => parseSignedHeaders(headers({ "x-hns-connection": "x".repeat(129) }))).toThrow(
    MachineRefusal,
  );
});

test("a missing, repeated, or malformed header is refused as unauthorized", () => {
  const cases: readonly IncomingHttpHeaders[] = [
    headers({ "x-hns-signature": "" }),
    headers({ "x-hns-nonce": ["nonce-0123456789abcdef", "nonce-0123456789abcdef"] }),
    headers({ "x-hns-seq": "0" }),
    headers({ "x-hns-timestamp": "yesterday" }),
    headers({ "x-hns-signature": "A".repeat(10) }),
  ];
  for (const input of cases) {
    expect(() => parseSignedHeaders(input)).toThrow(MachineRefusal);
  }
});

test("an unknown operation or a non-JSON body is refused", () => {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
  expect(parseOperation(encode('{"op":"read","path":"a.txt"}'))).toStrictEqual({
    op: "read",
    path: "a.txt",
  });
  expect(parseOperation(encode('{"op":"health"}'))).toStrictEqual({ op: "health" });
  expect(() => parseOperation(encode('{"op":"bash","command":"id"}'))).toThrow(MachineRefusal);
  expect(() => parseOperation(encode("not json"))).toThrow(MachineRefusal);
  expect(() => parseOperation(encode('{"op":"read"}'))).toThrow(MachineRefusal);
  expect(() => parseOperation(encode('{"op":"list","path":42}'))).toThrow(MachineRefusal);
});

// Catches: a write accepted without the intent hash or the operation id, so the
// machine could write bytes the journal cannot name.
test("a write operation carries its project, path, and intent", () => {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
  const request = {
    op: "write",
    projectRoot: "projects/one",
    path: "a.txt",
    expectedVersion: "absent",
    operationId: "op-1",
    content: "aGVsbG8=",
    contentHash: "sha256:" + "1".repeat(64),
  };
  expect(parseOperation(encode(JSON.stringify(request)))).toStrictEqual(request);
  expect(() => parseOperation(encode(JSON.stringify({ ...request, contentHash: "nope" })))).toThrow(
    MachineRefusal,
  );
  expect(() => parseOperation(encode(JSON.stringify({ ...request, operationId: "" })))).toThrow(
    MachineRefusal,
  );
});

test("a response body is parsed at the boundary", () => {
  const success = parseResponseBody(
    JSON.stringify({ ok: true, op: "health", result: { root: "/root", pid: 7 } }),
  );
  expect(success.ok).toBe(true);
  if (!success.ok) throw new Error("expected a success");
  expect(parseHealthResult(success.result)).toStrictEqual({ root: "/root", pid: 7 });

  const refusal = parseResponseBody(
    JSON.stringify({ ok: false, code: "busy", message: "too many" }),
  );
  expect(refusal.ok).toBe(false);
  if (refusal.ok) throw new Error("expected a refusal");
  expect(refusal.code).toBe("busy");

  expect(parseStatResult({ exists: false })).toStrictEqual({ exists: false });
  expect(parseStatResult({ exists: true, kind: "file", size: 3, mtimeMs: 1.5 })).toStrictEqual({
    exists: true,
    kind: "file",
    size: 3,
    mtimeMs: 1.5,
  });
  expect(
    parseReadResult({ path: "a.txt", size: 3, version: "sha256:00", content: "YWJj" }),
  ).toStrictEqual({ path: "a.txt", size: 3, version: "sha256:00", content: "YWJj" });
  expect(parseListResult({ entries: [{ name: "a.txt", kind: "file" }] })).toStrictEqual({
    entries: [{ name: "a.txt", kind: "file" }],
  });
  expect(() => parseResponseBody("{}")).toThrow();
  expect(() =>
    parseResponseBody(JSON.stringify({ ok: false, code: "made-up", message: "x" })),
  ).toThrow();
  expect(() => parseStatResult({ exists: true, kind: "socket", size: 1, mtimeMs: 0 })).toThrow();
});

/** A checkpoint prepare answer, as the machine sends it. */
const prepare: CheckpointPrepareResult = {
  runId: "run-1",
  ref: "refs/hns/checkpoints/run-1",
  commit: "1".repeat(40),
  packKey: "checkpoints/" + "1".repeat(40) + ".pack",
  objectCount: 4,
  packBytes: 512,
  maxBlobBytes: 128,
  created: true,
};

// Catches: the checkpoint operation missing from the wire schema, or its time arriving as a
// string or a fraction of a second and being rounded by the machine instead of refused.
test("a checkpoint operation names its Run and an optional commit time", () => {
  const encode = (value: JsonValue): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
  expect(parseOperation(encode({ op: "checkpoint", runId: "run-1" }))).toStrictEqual({
    op: "checkpoint",
    runId: "run-1",
  });
  expect(
    parseOperation(encode({ op: "checkpoint", runId: "run-1", committedAt: 1_700_000_000 })),
  ).toStrictEqual({ op: "checkpoint", runId: "run-1", committedAt: 1_700_000_000 });
  expect(
    parseOperation(encode({ op: "checkpoint", runId: "run-1", committedAt: 0 })),
  ).toStrictEqual({ op: "checkpoint", runId: "run-1", committedAt: 0 });
  const malformed: readonly JsonValue[] = [
    { op: "checkpoint" },
    { op: "checkpoint", runId: "" },
    { op: "checkpoint", runId: "run-1", committedAt: "1700000000" },
    { op: "checkpoint", runId: "run-1", committedAt: 1.5 },
    { op: "checkpoint", runId: "run-1", committedAt: -1 },
  ];
  for (const body of malformed) {
    expect(() => parseOperation(encode(body))).toThrow(MachineRefusal);
  }
});

// Catches: a checkpoint answer that gained the pack\u0027s bytes. The result is the checkpoint
// contract\u0027s prepare answer, where no field can hold a pack, and it is parsed at the boundary so
// a field added later is refused rather than read as if it were still the old shape.
test("a checkpoint answer is metadata only", () => {
  // The answer travels as JSON text; parsing it yields the JsonValue the agent's answer carries.
  const wire = parseJsonValue(JSON.stringify(prepare));
  expect(parseCheckpointResult(wire)).toStrictEqual(prepare);
  expect(() =>
    parseCheckpointResult(parseJsonValue(JSON.stringify({ ...prepare, objectCount: -1 }))),
  ).toThrow();
  expect(() =>
    parseCheckpointResult(parseJsonValue(JSON.stringify({ ...prepare, commit: "" }))),
  ).toThrow();
  const upload = parseCheckpointPackResult(
    parseJsonValue(JSON.stringify({ runId: "run-1", receivedBytes: 512 })),
  );
  expect(upload).toStrictEqual({ runId: "run-1", receivedBytes: 512 });
  expect(() =>
    parseCheckpointPackResult(parseJsonValue(JSON.stringify({ runId: "run-1" }))),
  ).toThrow();
});

/** Parse untrusted text into a JSON value, which is the shape an answer's `result` arrives in. */
function parseJsonValue(text: string): JsonValue {
  return v.parse(JsonValueSchema, JSON.parse(text));
}

// Catches: an answer envelope that cannot carry a pack upload, so the caller would read a
// successful upload as an unknown response.
test("a pack upload answers with its own success shape", () => {
  const body = parseResponseBody(
    JSON.stringify({
      ok: true,
      op: PACK_RESPONSE_OP,
      result: { runId: "run-1", receivedBytes: 3 },
    }),
  );
  expect(body.ok).toBe(true);
  if (!body.ok) throw new Error("expected a success");
  expect(body.op).toBe("pack");
  expect(parseCheckpointPackResult(body.result)).toStrictEqual({
    runId: "run-1",
    receivedBytes: 3,
  });
  expect(() =>
    parseResponseBody(JSON.stringify({ ok: true, op: "pack", result: {} })),
  ).not.toThrow();
});

// Catches: the pack route read loosely, so a path that is not one Run\u0027s pack could reach the
// upload, or a Run id carrying a separator could name a nested path.
test("the pack route names one Run and reads back", () => {
  expect(checkpointPackPath("run-1")).toBe("/rpc/checkpoint/run-1/pack");
  expect(checkpointPackRunId(checkpointPackPath("run-1"))).toBe("run-1");
  for (const path of [
    "/rpc",
    "/rpc/checkpoint//pack",
    "/rpc/checkpoint/run-1",
    "/rpc/checkpoint/run-1/pack/",
    "/rpc/checkpoint/run-1/other",
    "/rpc/checkpoint/run-1/run-2/pack",
    "/other/checkpoint/run-1/pack",
  ]) {
    expect(checkpointPackRunId(path), path).toBeUndefined();
  }
});

// Catches: the pack bound or media type drifting from the checkpoint contract\u0027s, which the
// Worker\u0027s receiver and the mirror also read.
test("the pack bound is the checkpoint contract\u0027s 64 MiB", () => {
  expect(MACHINE_PACK_CONTENT_TYPE).toBe(CHECKPOINT_PACK_CONTENT_TYPE);
  expect(MACHINE_PACK_CONTENT_TYPE).toBe("application/x-git-pack");
  expect(MAX_CHECKPOINT_PACK_BYTES).toBe(64 * 1024 * 1024);
  expect(fitsCheckpointPack(MAX_CHECKPOINT_PACK_BYTES)).toBe(true);
  expect(fitsCheckpointPack(MAX_CHECKPOINT_PACK_BYTES + 1)).toBe(false);
});
