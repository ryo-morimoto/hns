import { expect, test } from "vitest";
import {
  FAILURE_STATUS,
  FAILURE_CODES,
  failureStatus,
  failureStatusOrNull,
  type FailureSurface,
} from "./status.ts";

/** Every face the table serves. */
const SURFACES: readonly FailureSurface[] = [
  "edge",
  "gateway",
  "files",
  "session-rpc",
  "workspace-rpc",
  "graphql",
];

// Catches: two faces drifting to different statuses for one code, or a row with no face.
test("one row per code decides the status every face reads", () => {
  expect(Object.keys(FAILURE_STATUS).sort()).toStrictEqual([...FAILURE_CODES].sort());
  for (const code of FAILURE_CODES) {
    const row = FAILURE_STATUS[code];
    expect(row.surfaces.length, code).toBeGreaterThan(0);
    if ((row.transport as string) === "graphql") expect(row.status, code).toBeNull();
    else expect(row.status, code).toBeTypeOf("number");
  }
});

// Catches: a face reading a status for a code it does not answer with.
test("a face reads only codes its rows declare", () => {
  for (const surface of SURFACES) {
    for (const code of FAILURE_CODES) {
      const declared = FAILURE_STATUS[code].surfaces.some((row) => row === surface);
      if (!declared) {
        expect(() => failureStatusOrNull(surface, code as never), surface + "/" + code).toThrow();
      }
    }
  }
});

// Catches: the status a face answers with changing while the table was introduced.
test("the faces keep the statuses their callers already branch on", () => {
  expect(failureStatus("edge", "unauthorized")).toBe(401);
  expect(failureStatus("edge", "method_not_allowed")).toBe(405);
  expect(failureStatus("edge", "payload_too_large")).toBe(413);
  expect(failureStatus("edge", "upgrade_required")).toBe(426);
  expect(failureStatus("edge", "not_implemented")).toBe(501);
  expect(failureStatus("edge", "timeout")).toBe(504);
  expect(failureStatus("gateway", "budget_exceeded")).toBe(429);
  expect(failureStatus("gateway", "stopped")).toBe(503);
  expect(failureStatus("gateway", "upstream")).toBe(502);
  expect(failureStatus("files", "denied")).toBe(400);
  expect(failureStatus("files", "conflict")).toBe(409);
  expect(failureStatus("files", "lease_expired")).toBe(409);
  expect(failureStatus("session-rpc", "limit_exceeded")).toBe(429);
  expect(failureStatus("session-rpc", "limit_unavailable")).toBe(503);
  expect(failureStatus("workspace-rpc", "lease_epoch_stale")).toBe(409);
  expect(failureStatus("workspace-rpc", "denied")).toBe(400);
});

// Catches: a GraphQL code reading an HTTP status it does not have (its failure is a union member).
test("a GraphQL code has no status", () => {
  expect(FAILURE_STATUS.limit_exceeded.surfaces).toContain("graphql");
  expect(() => failureStatusOrNull("session-rpc", "forbidden" as never)).toThrow();
  expect(FAILURE_STATUS.invalid_request.surfaces).toContain("graphql");
  expect(FAILURE_STATUS.invalid_request.surfaces).toContain("edge");
});
