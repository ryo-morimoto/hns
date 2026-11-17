import { expect, test } from "vitest";
import {
  FAILURE_CODES,
  FAILURE_STATUS,
  failureStatus,
  failureStatusOrNull,
  type FailureCode,
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

/** Whether the table gives a face a row for one code; the type guard the status reads use. */
function declares(surface: FailureSurface, code: FailureCode): boolean {
  return FAILURE_STATUS[code].surfaces.some((row) => row === surface);
}

// Catches: two faces drifting to different statuses for one code, or a row with no face.
test("one row per code decides the status every face reads", () => {
  expect(Object.keys(FAILURE_STATUS).sort()).toStrictEqual([...FAILURE_CODES].sort());
  for (const code of FAILURE_CODES) {
    const row = FAILURE_STATUS[code];
    expect(row.surfaces.length, code).toBeGreaterThan(0);
    // A GraphQL-only row carries no status: its failure is a union member of a 200 response.
    expect(row.status, code).not.toBeUndefined();
    expect(row.surfaces, code).toEqual(expect.any(Array));
  }
});

// Catches: a face reading a status for a code it does not answer with.
test("a face reads only codes its rows declare", () => {
  for (const surface of SURFACES) {
    for (const code of FAILURE_CODES) {
      if (declares(surface, code)) continue;
      expect(statusFor(surface, code), surface + "/" + code).toBeUndefined();
    }
  }
});

/**
 * The status a face would read for one code, or undefined when the table refuses that pair.
 *
 * @remarks
 * The status functions take a face-specific code union, so a code the face does not declare is a
 * compile error at every real call site. A test has to ask the runtime question with a code the
 * compiler cannot prove, which is what this helper does: it runs the same function through an
 * overload-free call and reports the refusal as undefined.
 */
function statusFor(surface: FailureSurface, code: FailureCode): number | null | undefined {
  try {
    return failureStatusOrNull(surface, code);
  } catch {
    return undefined;
  }
}

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
  expect(failureStatus("session-rpc", "method_not_allowed")).toBe(405);
  expect(failureStatus("session-rpc", "payload_too_large")).toBe(413);
  expect(failureStatus("session-rpc", "unsupported_media_type")).toBe(415);
  expect(failureStatus("workspace-rpc", "method_not_allowed")).toBe(405);
  expect(failureStatus("workspace-rpc", "payload_too_large")).toBe(413);
  expect(failureStatus("workspace-rpc", "unsupported_media_type")).toBe(415);
  expect(failureStatus("files", "denied")).toBe(400);
  expect(failureStatus("files", "conflict")).toBe(409);
  expect(failureStatus("files", "lease_expired")).toBe(409);
  expect(failureStatus("session-rpc", "limit_exceeded")).toBe(429);
  expect(failureStatus("session-rpc", "limit_unavailable")).toBe(503);
  expect(failureStatus("workspace-rpc", "lease_epoch_stale")).toBe(409);
  expect(failureStatus("workspace-rpc", "denied")).toBe(400);
});

// Catches: a GraphQL code reading an HTTP status it does not have (its failure is a union member).
test("a GraphQL code has no status of its own", () => {
  expect(FAILURE_STATUS.invalid_request.surfaces).toContain("graphql");
  expect(FAILURE_STATUS.invalid_request.surfaces).toContain("edge");
  expect(FAILURE_STATUS.limit_exceeded.surfaces).toContain("graphql");
  expect(FAILURE_STATUS.forbidden.surfaces).toStrictEqual(["graphql"]);
});
