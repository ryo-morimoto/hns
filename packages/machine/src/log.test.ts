import { expect, test } from "vitest";
import { formatObsLog, isoTimestamp, parseObsLog } from "@hns/core";
import type { ObsLogEntry } from "@hns/core";
import { REDACTED, machineEntry, redactingSink, requestIdOf } from "./log.ts";

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

/**
 * The machine's log redaction (C5, 0246).
 *
 * The log entry is an allowlisted shape, so a mirror token cannot arrive as a field. The guard
 * covers the other route: a secret that a message, a path, or a future field carried as text.
 */

/** A line with the one place a secret could appear as text, plus a benign field. */
function entry(op: string, code: string): ObsLogEntry {
  return {
    v: 1,
    at: isoTimestamp("2026-11-18T00:00:00.000Z"),
    level: "info",
    event: "fs.op",
    hop: "fs",
    requestId: "request-1",
    path: "/run-1",
    status: 200,
    detail: { op, code },
  };
}

// Catches: a token reaching the log because it appeared in a field's text (a message, a path, a
// detail value), or the redaction changing the line's shape.
test("a token in any field's text is redacted before the line is written", () => {
  const written: ObsLogEntry[] = [];
  const sink = redactingSink((line) => written.push(line), ["art_v2_x_secret_0123"]);
  sink(entry("mirror art_v2_x_secret_0123", "ok"));
  expect(written).toHaveLength(1);
  const line = JSON.stringify(written[0]);
  expect(line).not.toContain("art_v2_x_secret_0123");
  expect(line).toContain(REDACTED);
  expect(written[0]?.path).toBe("/run-1");
  expect(written[0]?.event).toBe("fs.op");
});

// Catches: a sink that redacts every line even when there is nothing to redact (a cost on every
// request), or one that turns an empty or short "secret" into a redaction of the whole line.
test("a sink with nothing to redact writes the entry unchanged", () => {
  const written: ObsLogEntry[] = [];
  const unchanged = redactingSink((line) => written.push(line), [undefined, "", "ab"]);
  const original = entry("mirror", "ok");
  unchanged(original);
  expect(written).toStrictEqual([original]);
});
