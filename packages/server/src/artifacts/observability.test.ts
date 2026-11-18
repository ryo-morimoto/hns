import { formatObsLog, ObsLogEntrySchema, parseObsLog } from "@hns/core";
import * as v from "valibot";
import { expect, test } from "vitest";
import {
  mirrorLevelOf,
  mirrorMetricsOf,
  mirrorObservationEntry,
  mirrorRowOf,
  mirrorRowsOf,
} from "./observability.ts";

const at = Date.parse("2026-11-18T00:00:00.000Z");

/** One observed mirror, as the Workspace object builds it. */
const observed = (overrides: Partial<Parameters<typeof mirrorObservationEntry>[0]> = {}) =>
  mirrorObservationEntry({
    repo: "ws-w1",
    status: "mirrored",
    requestId: "req-1",
    now: at,
    durationMs: 100,
    ...overrides,
  });

// C2 / T2: Catches a mirror line that carries a secret, a remote, or an unclosed word. The entry is
// the allowlisted shape, so the only fields on the wire are the ones the log knows.
test("a mirror observation carries the closed words and the repository, and nothing else", () => {
  const line = v.parse(ObsLogEntrySchema, JSON.parse(formatObsLog(observed({ durationMs: 250 }))));
  expect(line).toStrictEqual({
    v: 1,
    at: "2026-11-18T00:00:00.000Z",
    level: "info",
    event: "artifacts.mirror",
    hop: "do",
    requestId: "req-1",
    durationMs: 250,
    detail: { mirror: "mirrored", repos: "ws-w1" },
  });
});

// C2 / T2: Catches a token that a future field smuggled in — the observation's own type has no
// field a token could take, and the log's allowlist has no key for one. The token here is what a
// push would have carried; it is not passed at all, and the line cannot grow one.
test("a token never reaches a mirror observation", () => {
  const token = "art_v2_x_secret_0123456789";
  const entry = observed({ status: "failed", failure: "unauthorized" });
  const text = formatObsLog(entry);
  expect(text).not.toContain(token);
  expect(text).not.toContain("art_v2");
  // The remote is not a field either: a repository is named, its URL is not.
  expect(text).not.toContain("https://");
  // A detail key the allowlist does not know is dropped even if a caller built one by hand.
  const widened = parseObsLog({ ...entry, detail: { ...entry.detail, token } });
  expect(JSON.stringify(widened)).not.toContain(token);
  expect(formatObsLog(widened)).not.toContain(token);
});

// Catches a failed mirror being written at `error` (it would inflate `/api/metrics`' `errors`) or a
// skipped one at `warn` (it is the mirror working as designed).
test("the severity names the state: failed is warn, the rest are info", () => {
  expect(mirrorLevelOf("failed")).toBe("warn");
  expect(mirrorLevelOf("mirrored")).toBe("info");
  expect(mirrorLevelOf("skipped")).toBe("info");
  expect(mirrorLevelOf("pending")).toBe("info");
  const failed = observed({ status: "failed", failure: "network" });
  expect(failed.level).toBe("warn");
  expect(failed.detail?.failure).toBe("network");
});

// C2 / T2: Given push failures, the failure rate rises; the skip rate is skipped over all outcomes
// and the p95 is the timed pushes'. Catches rates divided by the wrong denominator, and a p95 that
// takes the maximum or ignores the duration.
test("the mirror's rates divide by every outcome and the p95 is the timed pushes'", () => {
  const rows = mirrorRowsOf([
    observed({ durationMs: 10 }),
    observed({ durationMs: 20 }),
    observed({ durationMs: 30 }),
    observed({ durationMs: 40 }),
    observed({ durationMs: 50 }),
    observed({ status: "failed", failure: "network", durationMs: 400 }),
    observed({ status: "skipped", durationMs: undefined }),
    observed({ repo: "ws-w2", durationMs: 60 }),
  ]);
  const metrics = mirrorMetricsOf(rows, 86_400_000);
  expect(metrics.total).toBe(8);
  expect(metrics.states).toStrictEqual({ mirrored: 6, skipped: 1, failed: 1, pending: 0 });
  expect(metrics.failureRate).toBeCloseTo(1 / 8);
  expect(metrics.skipRate).toBeCloseTo(1 / 8);
  // The eight timed pushes sorted: 10 20 30 40 50 60 400; the nearest rank of 7 is index 6 (400).
  expect(metrics.p95Ms).toBe(400);
  // Two repositories in the window: the mirror ran for w1 and w2.
  expect(metrics.repos).toBe(2);
});

// Catches a skip that enters the percentile (it has no push time) and an empty window answering a
// non-zero rate or a NaN.
test("a skip has no push time, and an empty window has zero rates", () => {
  const onlySkips = mirrorMetricsOf(
    mirrorRowsOf([observed({ status: "skipped", durationMs: undefined })]),
    1_000,
  );
  expect(onlySkips.p95Ms).toBe(0);
  expect(onlySkips.skipRate).toBe(1);
  expect(onlySkips.failureRate).toBe(0);
  const empty = mirrorMetricsOf([], 86_400_000);
  expect(empty).toStrictEqual({
    windowMs: 86_400_000,
    total: 0,
    states: { mirrored: 0, skipped: 0, failed: 0, pending: 0 },
    failureRate: 0,
    skipRate: 0,
    p95Ms: 0,
    repos: 0,
  });
});

// Catches a corrupt or foreign row being counted: another event is not a mirror, and a mirror row
// whose state is not one of the contract's four is skipped rather than defaulted.
test("only a mirror row with a known state is counted", () => {
  expect(mirrorRowOf(observed())).toStrictEqual({
    status: "mirrored",
    repo: "ws-w1",
    durationMs: 100,
  });
  expect(mirrorRowOf({ ...observed(), event: "http" })).toBeUndefined();
  const unknownState = parseObsLog({ ...observed(), detail: { mirror: "maybe", repos: "ws-w1" } });
  expect(mirrorRowOf(unknownState)).toBeUndefined();
  expect(mirrorMetricsOf(mirrorRowsOf([unknownState]), 1)).toStrictEqual(mirrorMetricsOf([], 1));
});
