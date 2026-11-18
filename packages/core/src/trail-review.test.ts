import { expect, test } from "vitest";
import {
  trailApprovalHolds,
  trailCurrentApproval,
  trailFindingBlocks,
  trailGateLine,
  trailGates,
  trailReviseInput,
} from "./trail.ts";
import type { TrailDecision, TrailFinding } from "./trail.ts";

/**
 * The review rules the gate and the approval rest on (C2, C3, C4).
 *
 * @remarks
 * These are the rules the server answers with and the screen draws from: the same functions run
 * behind `Trail.gates`, `decideTrail`, and the web's approval sentence. The cases are the ones
 * the issue names — a head that moves, a high finding that is open, a revise that carries its
 * points — plus the fail-closed shapes (an approval that names nothing, a dismissal, a note with
 * no weight).
 */

const HEAD_1 = "1".repeat(40);
const HEAD_2 = "2".repeat(40);

/** A decision with the fields the rules read. */
function decision(
  action: TrailDecision["action"],
  head: string | null,
): Pick<TrailDecision, "action" | "head_commit"> {
  return { action, head_commit: head };
}

/** A finding with the fields the gate reads. */
function finding(
  severity: TrailFinding["severity"],
  status: TrailFinding["status"],
  extra: Partial<Pick<TrailFinding, "file" | "hunk" | "summary">> = {},
): Pick<TrailFinding, "severity" | "status" | "file" | "hunk" | "summary"> {
  return {
    severity,
    status,
    file: extra.file ?? null,
    hunk: extra.hunk ?? null,
    summary: extra.summary ?? "a point",
  };
}

// Catches: an approval that holds for a head it did not name — the stale approval C2 is about.
test("an approval holds only for the head it names", () => {
  expect(trailApprovalHolds(decision("approve", HEAD_1), HEAD_1)).toBe(true);
  expect(trailApprovalHolds(decision("approve", HEAD_1), HEAD_2)).toBe(false);
});

// Catches: an approval with no head, or one read as valid against a Trail with no Change, being
// counted — a decision that cannot be checked has to fail closed.
test("an approval that names no head holds for nothing", () => {
  expect(trailApprovalHolds(decision("approve", null), HEAD_1)).toBe(false);
  expect(trailApprovalHolds(decision("approve", null), undefined)).toBe(false);
  expect(trailApprovalHolds(decision("approve", HEAD_1), undefined)).toBe(false);
});

// Catches: a request_changes or a reject read as an approval.
test("only an approval is an approval", () => {
  expect(trailApprovalHolds(decision("request_changes", HEAD_1), HEAD_1)).toBe(false);
  expect(trailApprovalHolds(decision("reject", HEAD_1), HEAD_1)).toBe(false);
});

// Catches: the list read oldest-first, which would answer the first approval instead of the last.
test("the approval in force is the newest one for this head", () => {
  const decisions = [
    decision("approve", HEAD_2),
    decision("request_changes", HEAD_2),
    decision("approve", HEAD_1),
  ];
  expect(trailCurrentApproval(decisions, HEAD_2)?.head_commit).toBe(HEAD_2);
  expect(trailCurrentApproval(decisions, "3".repeat(40))).toBeUndefined();
});

// Catches: a medium or low finding blocking a merge, a dismissed high one blocking, and a note
// with no weight being read as a severity that blocks.
test("only an open high finding blocks", () => {
  expect(trailFindingBlocks(finding("high", "open"))).toBe(true);
  expect(trailFindingBlocks(finding("high", "resolved"))).toBe(false);
  expect(trailFindingBlocks(finding("high", "dismissed"))).toBe(false);
  for (const severity of ["medium", "low", "none"] as const) {
    expect(trailFindingBlocks(finding(severity, "open"))).toBe(false);
  }
});

// Catches: a gate set that passes by default for a Trail with no change (nothing to approve, no
// evidence, nothing compared), and a freshness gate that cannot say "not compared".
test("a Trail with no Change asks rather than passes", () => {
  const gates = trailGates({ head: undefined, fresh: true, findings: [], decisions: [] });
  expect(gates.map((gate) => gate.gate)).toStrictEqual([
    "human_review",
    "tests",
    "findings",
    "freshness",
  ]);
  expect(gates.map((gate) => gate.status)).toStrictEqual(["fail", "ask", "pass", "ask"]);
});

// Catches: a merge reported ready while something stops it, and a reason that does not name the
// gate — the one line C3 asks for.
test("the line names every gate that stops the merge", () => {
  const blockedByFindings = trailGates({
    head: HEAD_1,
    fresh: true,
    findings: [finding("high", "open"), finding("high", "open"), finding("low", "open")],
    decisions: [decision("approve", HEAD_1)],
  });
  const line = trailGateLine(blockedByFindings);
  expect(line.startsWith("merge: blocked — ")).toBe(true);
  expect(line).toContain("findings (2 high finding(s) open)");
  expect(line).not.toContain("human_review");
  // tests is `ask`, and an unanswered gate has not passed: it is in the line.
  expect(line).toContain("tests");

  const approvedButStale = trailGates({
    head: HEAD_2,
    fresh: false,
    findings: [],
    decisions: [decision("approve", HEAD_1)],
  });
  const stale = trailGateLine(approvedButStale);
  expect(stale).toContain("human_review (not approved at " + HEAD_2 + ")");
  expect(stale).toContain("freshness (the base moved");
});

// Catches: the line claimed ready while a gate is still ask — "nobody answered" is not "passed".
test("merge is ready only when every gate passes", () => {
  const gates = trailGates({
    head: HEAD_1,
    fresh: true,
    findings: [],
    decisions: [decision("approve", HEAD_1)],
  });
  expect(gates.find((gate) => gate.gate === "tests")?.status).toBe("ask");
  expect(trailGateLine(gates)).toContain("tests");
  expect(trailGateLine(gates.filter((gate) => gate.gate !== "tests"))).toBe("merge: ready");
});

// Catches: a revise input that drops a point, orders low before high, or sends resolved points —
// the loop C4 is about.
test("a revise carries the open findings, high first, with where they are", () => {
  const input = trailReviseInput(
    [
      finding("low", "open", { summary: "rename it", file: "b.ts" }),
      finding("high", "resolved", { summary: "fixed already" }),
      finding("high", "open", { summary: "loops", file: "a.ts", hunk: "@@ -1,2 +1,4 @@" }),
      finding("none", "open", { summary: "a note" }),
    ],
    HEAD_1,
  );
  expect(input.split("\n")).toStrictEqual([
    "Review findings to address (head " + HEAD_1 + "):",
    "- [high] a.ts @@ -1,2 +1,4 @@: loops",
    "- [low] b.ts: rename it",
    "- [none] a note",
  ]);
});

// Catches: a revise with nothing to say being sent as an empty list of points, or a heading.
test("a revise with nothing open has nothing to hand over", () => {
  expect(trailReviseInput([], HEAD_1)).toBe("");
  expect(trailReviseInput([finding("high", "dismissed")], HEAD_1)).toBe("");
});
