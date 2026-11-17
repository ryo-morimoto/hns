import { expect, test } from "vitest";
import { formatObsLog, parseObsLog } from "@hns/core";
import { machineEntry, requestIdOf } from "./log.ts";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");

// Catches: a malformed header being treated as a correlation id, or a missing one generating one.
test("only a well-formed inbound request id is used", () => {
  expect(requestIdOf({ "x-request-id": "req-1" })).toBe("req-1");
  expect(requestIdOf({})).toBeNull();
  expect(requestIdOf({ "x-request-id": "bad id" })).toBeNull();
  expect(requestIdOf({ "x-request-id": "x".repeat(129) })).toBeNull();
  expect(requestIdOf({ "x-request-id": ["req-2", "req-3"] })).toBe("req-2");
});

// Catches: the fs path, an operation, or file content reaching the line differently than the server.
test("the machine line is the same shape as the server line and keeps no content", () => {
  const entry = machineEntry({
    requestId: "req-1",
    path: "/src/a.ts?token=super-secret",
    status: 200,
    durationMs: 3,
    op: "read",
    now: NOW,
  });
  expect(entry).toMatchObject({
    event: "fs.op",
    hop: "fs",
    requestId: "req-1",
    path: "/src/a.ts",
    status: 200,
    detail: { op: "read" },
  });
  const line = formatObsLog(parseObsLog(entry));
  expect(line).not.toContain("super-secret");
  expect(line).not.toContain("content");
});

test("a request without an id logs a null correlation", () => {
  expect(
    machineEntry({ requestId: null, path: "/rpc", status: 401, durationMs: 1, now: NOW }),
  ).toMatchObject({ requestId: null, level: "warn", path: "/rpc" });
});
