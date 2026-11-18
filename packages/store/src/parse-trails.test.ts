import { describe, expect, test } from "vitest";
import * as v from "valibot";
import {
  TRAIL_ACTOR_KINDS,
  TRAIL_CHANGE_STATES,
  TRAIL_DECISION_ACTIONS,
  TRAIL_EVAL_STATUSES,
  TRAIL_FEEDBACK_CHANNELS,
  TRAIL_FEEDBACK_SENTIMENTS,
  TRAIL_FINDING_SEVERITIES,
  TRAIL_FINDING_SOURCES,
  TRAIL_FINDING_STATUSES,
  TRAIL_GATE_KINDS,
  TRAIL_GATE_STATUSES,
  TRAIL_KINDS,
  TRAIL_PRIORITIES,
  TRAIL_STATES,
} from "@hns/core";
import {
  parseTrail,
  parseTrailChange,
  parseTrailDecision,
  parseTrailEval,
  parseTrailFeedback,
  parseTrailFinding,
  parseTrailGate,
  parseTrailMetric,
  parseTrailNote,
  parseTrailSession,
} from "./parse.ts";

/**
 * The Trail parsers at the database boundary.
 *
 * @remarks
 * A row is untrusted until it passes its schema, and each closed vocabulary is the failure the
 * issue calls out: an unknown state, severity, or gate must throw, never fall back. These tests
 * drive every vocabulary member through its parser, so a constant that loses a member is caught
 * here as well as in the migration's CHECK.
 */

const trailRow = {
  id: "t1",
  project_id: "p1",
  title: "title",
  description: "why",
  acceptance: "how",
  kind: "feature",
  state: "draft",
  priority: "normal",
  created_by: "u1",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns,
   anti-slop/no-unsafe-dictionary-type --
   This helper is the test's own boundary: it hands a parser a row whose column holds a value of
   the wrong type, which is exactly what the parser must refuse.
*/

/**
 * Break one column of a row and expect the parser to throw.
 *
 * @param parse - The parser under test; it takes an unparsed row and may throw.
 * @param source - A row that parses.
 * @param change - The column to break and the value to put there.
 */
function expectRefused(
  parse: (input: unknown) => unknown,
  source: Readonly<Record<string, unknown>>,
  change: { readonly column: string; readonly value: unknown },
): void {
  expect(
    () => parse({ ...source, [change.column]: change.value }),
    change.column + "=" + String(change.value),
  ).toThrow(v.ValiError);
}

describe("parseTrail", () => {
  test("parses a row with every column", () => {
    expect(parseTrail(trailRow)).toStrictEqual(trailRow);
  });

  // Catches: a state this build does not know being read as a draft, which the issue's C2 names.
  test("refuses a state outside the vocabulary", () => {
    expectRefused(parseTrail, trailRow, { column: "state", value: "blocked" });
    expectRefused(parseTrail, trailRow, { column: "state", value: "" });
  });

  test("refuses a kind or priority outside the vocabulary", () => {
    expectRefused(parseTrail, trailRow, { column: "kind", value: "task" });
    expectRefused(parseTrail, trailRow, { column: "priority", value: "critical" });
  });

  test("refuses a missing column", () => {
    const { acceptance: _omitted, ...withoutAcceptance } = trailRow;
    expect(() => parseTrail(withoutAcceptance)).toThrow(v.ValiError);
  });

  test("accepts every state, kind, and priority the model declares", () => {
    for (const state of TRAIL_STATES)
      expect(parseTrail({ ...trailRow, state }).state, state).toBe(state);
    for (const kind of TRAIL_KINDS) expect(parseTrail({ ...trailRow, kind }).kind, kind).toBe(kind);
    for (const priority of TRAIL_PRIORITIES)
      expect(parseTrail({ ...trailRow, priority }).priority, priority).toBe(priority);
  });
});

const changeRow = {
  id: "c1",
  trail_id: "t1",
  workspace_id: "ws",
  repo_id: null,
  base_commit: "a",
  head_commit: "b",
  run_id: null,
  state: "open",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("parseTrailChange", () => {
  test("parses a change with no repository and no run", () => {
    expect(parseTrailChange(changeRow)).toStrictEqual(changeRow);
  });

  test("refuses a state outside the vocabulary", () => {
    expectRefused(parseTrailChange, changeRow, { column: "state", value: "draft" });
    for (const state of TRAIL_CHANGE_STATES)
      expect(parseTrailChange({ ...changeRow, state }).state, state).toBe(state);
  });

  test("refuses a null workspace", () => {
    expectRefused(parseTrailChange, changeRow, { column: "workspace_id", value: null });
  });
});

describe("parseTrailSession", () => {
  const row = {
    id: "s1",
    trail_id: "t1",
    conversation_id: null,
    session_id: "session",
    run_id: null,
    linked_at: "2026-01-01T00:00:00.000Z",
  };

  test("parses a link with no conversation", () => {
    expect(parseTrailSession(row)).toStrictEqual(row);
  });
});

describe("parseTrailFeedback", () => {
  const row = {
    id: "f1",
    trail_id: "t1",
    change_id: null,
    channel: "support",
    summary: "still broken",
    sentiment: "negative",
    source_url: null,
    source: "zendesk",
    actor: "user",
    external_id: null,
    occurred_at: "2026-01-01T00:00:00.000Z",
    recorded_at: "2026-01-02T00:00:00.000Z",
    supersedes_id: null,
  };

  test("parses a feedback row", () => {
    expect(parseTrailFeedback(row)).toStrictEqual(row);
  });

  test("refuses a sentiment, channel, or actor outside the vocabulary", () => {
    expectRefused(parseTrailFeedback, row, { column: "sentiment", value: "angry" });
    expectRefused(parseTrailFeedback, row, { column: "channel", value: "twitter" });
    expectRefused(parseTrailFeedback, row, { column: "actor", value: "robot" });
  });

  test("accepts every sentiment, channel, and actor the model declares", () => {
    for (const sentiment of TRAIL_FEEDBACK_SENTIMENTS)
      expect(parseTrailFeedback({ ...row, sentiment }).sentiment, sentiment).toBe(sentiment);
    for (const channel of TRAIL_FEEDBACK_CHANNELS)
      expect(parseTrailFeedback({ ...row, channel }).channel, channel).toBe(channel);
    for (const actor of TRAIL_ACTOR_KINDS)
      expect(parseTrailFeedback({ ...row, actor }).actor, actor).toBe(actor);
  });
});

describe("parseTrailMetric", () => {
  const row = {
    id: "m1",
    trail_id: "t1",
    change_id: null,
    name: "error_rate",
    value: 0.4,
    unit: "percent",
    window_start: "2026-01-01T00:00:00.000Z",
    window_end: "2026-01-08T00:00:00.000Z",
    source: "grafana",
    external_id: null,
    occurred_at: "2026-01-08T00:00:00.000Z",
    recorded_at: "2026-01-08T01:00:00.000Z",
  };

  test("parses a metric row", () => {
    expect(parseTrailMetric(row)).toStrictEqual(row);
  });

  test("refuses a value that is not a number", () => {
    expectRefused(parseTrailMetric, row, { column: "value", value: "0.4" });
  });
});

describe("parseTrailEval", () => {
  const row = {
    id: "e1",
    trail_id: "t1",
    change_id: null,
    name: "e2e/auth",
    status: "pass",
    detail: null,
    source: "ci",
    occurred_at: "2026-01-01T00:00:00.000Z",
    recorded_at: "2026-01-01T00:00:00.000Z",
  };

  test("refuses a status outside the vocabulary", () => {
    expectRefused(parseTrailEval, row, { column: "status", value: "skipped" });
    for (const status of TRAIL_EVAL_STATUSES)
      expect(parseTrailEval({ ...row, status }).status, status).toBe(status);
  });
});

describe("parseTrailNote", () => {
  const row = {
    id: "n1",
    trail_id: "t1",
    body: "repro steps",
    author: "u1",
    occurred_at: "2026-01-01T00:00:00.000Z",
    recorded_at: "2026-01-01T00:00:00.000Z",
  };

  test("parses a note row", () => {
    expect(parseTrailNote(row)).toStrictEqual(row);
  });
});

describe("parseTrailDecision", () => {
  const row = {
    id: "d1",
    trail_id: "t1",
    change_id: "c1",
    actor: "u1",
    action: "approve",
    head_commit: "b",
    note: "looks right",
    at: "2026-01-01T00:00:00.000Z",
  };

  test("refuses an action outside the vocabulary", () => {
    expectRefused(parseTrailDecision, row, { column: "action", value: "merge" });
    for (const action of TRAIL_DECISION_ACTIONS)
      expect(parseTrailDecision({ ...row, action }).action, action).toBe(action);
  });
});

describe("parseTrailFinding", () => {
  const row = {
    id: "r1",
    trail_id: "t1",
    change_id: null,
    severity: "high",
    source: "agent",
    status: "open",
    file: "src/a.ts",
    hunk: "@@ -1 +1 @@",
    summary: "missing null check",
    created_at: "2026-01-01T00:00:00.000Z",
    resolved_at: null,
    resolved_by: null,
  };

  // Catches: an unknown severity read as `none`, which would stop a gate from blocking.
  test("refuses a severity, source, or status outside the vocabulary", () => {
    expectRefused(parseTrailFinding, row, { column: "severity", value: "critical" });
    expectRefused(parseTrailFinding, row, { column: "source", value: "bot" });
    expectRefused(parseTrailFinding, row, { column: "status", value: "wontfix" });
  });

  test("accepts every severity, source, and status the model declares", () => {
    for (const severity of TRAIL_FINDING_SEVERITIES)
      expect(parseTrailFinding({ ...row, severity }).severity, severity).toBe(severity);
    for (const source of TRAIL_FINDING_SOURCES)
      expect(parseTrailFinding({ ...row, source }).source, source).toBe(source);
    for (const status of TRAIL_FINDING_STATUSES)
      expect(parseTrailFinding({ ...row, status }).status, status).toBe(status);
  });
});

describe("parseTrailGate", () => {
  const row = {
    id: "g1",
    trail_id: "t1",
    change_id: null,
    gate: "tests",
    status: "pass",
    detail: null,
    evaluated_at: "2026-01-01T00:00:00.000Z",
  };

  // Catches: a gate name or status this build does not know being read as `ask`.
  test("refuses a gate or status outside the vocabulary", () => {
    expectRefused(parseTrailGate, row, { column: "gate", value: "metric_regression" });
    expectRefused(parseTrailGate, row, { column: "status", value: "skipped" });
  });

  test("accepts every gate and status the model declares", () => {
    for (const gate of TRAIL_GATE_KINDS)
      expect(parseTrailGate({ ...row, gate }).gate, gate).toBe(gate);
    for (const status of TRAIL_GATE_STATUSES)
      expect(parseTrailGate({ ...row, status }).status, status).toBe(status);
  });
});
