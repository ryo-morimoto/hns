import { expect, test } from "vitest";
import type { IncomingHttpHeaders } from "node:http";
import { MachineRefusal } from "./refusal.ts";
import {
  parseHealthResult,
  parseListResult,
  parseOperation,
  parseReadResult,
  parseResponseBody,
  parseSignedHeaders,
  parseStatResult,
} from "./wire.ts";

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
