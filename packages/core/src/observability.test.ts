import { expect, test } from "vitest";
import { isoTimestamp } from "./codecs.ts";
import {
  formatObsLog,
  OBS_HOPS,
  OBS_MAX_EVENTS,
  OBS_MAX_PATH_LENGTH,
  OBS_MAX_QUERY_LIMIT,
  OBS_RETENTION_DAYS,
  obsPath,
  parseObsLog,
  type ObsLogEntry,
} from "./observability.ts";
import { EVENT_NAMES } from "./types.ts";

function entry(overrides: Partial<ObsLogEntry> = {}): ObsLogEntry {
  return {
    v: 1,
    at: isoTimestamp("2026-11-17T00:00:00.000Z"),
    level: "info",
    event: "http",
    hop: "worker",
    requestId: "req-1",
    path: "/graphql",
    status: 200,
    durationMs: 4,
    ...overrides,
  };
}

test("the hop and event vocabularies are closed const arrays", () => {
  expect(OBS_HOPS).toStrictEqual(["browser", "worker", "do", "agent", "fs"]);
  expect(new Set(OBS_HOPS).size).toBe(OBS_HOPS.length);
  expect(EVENT_NAMES).toContain("do.rpc");
  expect(EVENT_NAMES).toContain("fs.op");
  expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length);
});

// Catches: a stored row with an unknown member silently becoming the first enum value.
test("an unknown hop, event, level, or request id is refused", () => {
  for (const raw of [
    { ...entry(), hop: "edge" },
    { ...entry(), event: "made.up" },
    { ...entry(), level: "debug" },
    { ...entry(), requestId: "bad id" },
    { ...entry(), status: 99 },
  ]) {
    expect(() => parseObsLog(raw)).toThrow();
  }
});

// Catches: a caller persisting a body, a header, or a token through detail.
test("body, headers, tokens, and unknown detail keys never reach the line", () => {
  const raw = {
    ...entry(),
    body: "super-secret-body",
    headers: { cookie: "super-secret-cookie" },
    token: "super-secret-token",
    detail: {
      tool: "read_file",
      body: "super-secret-body",
      headers: { cookie: "super-secret-cookie" },
      token: "super-secret-token",
    },
  };
  const line = formatObsLog(parseObsLog(raw));
  expect(line).not.toContain("super-secret");
  const parsed: unknown = JSON.parse(line);
  expect(parsed).toStrictEqual({
    v: 1,
    at: "2026-11-17T00:00:00.000Z",
    level: "info",
    event: "http",
    hop: "worker",
    requestId: "req-1",
    path: "/graphql",
    status: 200,
    durationMs: 4,
    detail: { tool: "read_file" },
  });
});

// Catches: the server and the machine writing two different shapes.
test("the server and the machine write the same line shape", () => {
  const server = entry({ detail: { tool: "read_file" } });
  const machine = entry({
    event: "fs.op",
    hop: "fs",
    path: "/src/a.ts",
    status: 200,
    detail: { op: "read", bytes: 12 },
  });
  const serverLine = parseObsLog(JSON.parse(formatObsLog(server)));
  const machineLine = parseObsLog(JSON.parse(formatObsLog(machine)));
  expect(Object.keys(serverLine)).toStrictEqual(Object.keys(machineLine));
  expect(machineLine.hop).toBe("fs");
  expect(machineLine.detail).toStrictEqual({ op: "read", bytes: 12 });
});

// Catches: a query-string token or a fragment reaching the log.
test("a path keeps only the pathname and is capped", () => {
  expect(obsPath("/a/b?token=secret#fragment")).toBe("/a/b");
  expect(obsPath("https://hns.test/a/b?token=secret")).toBe("/a/b");
  expect(obsPath("relative/path")).toBe("/relative/path");
  expect(obsPath("/" + "x".repeat(2_000))).toHaveLength(OBS_MAX_PATH_LENGTH);
  expect(obsPath("/a?x=1").includes("?")).toBe(false);
});

test("the retention, cap, and query constants are fixed", () => {
  expect(OBS_RETENTION_DAYS).toBe(30);
  expect(OBS_MAX_EVENTS).toBe(5_000);
  expect(OBS_MAX_QUERY_LIMIT).toBe(500);
  expect(OBS_MAX_PATH_LENGTH).toBe(512);
});
