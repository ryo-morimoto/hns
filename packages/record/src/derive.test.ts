import { expect, test } from "vitest";

import { deriveDoneLevel } from "./derive.ts";
import { baseRecord } from "../test/support/records.ts";

test("criteria that all pass reach verified", () => {
  expect(deriveDoneLevel(baseRecord())).toBe("verified");
});

test("failed criteria keep the record at intended", () => {
  const record = baseRecord();
  expect(
    deriveDoneLevel({
      ...record,
      criteria: [{ id: "C1", kind: "test", status: "failed", note: "red" }],
    }),
  ).toBe("intended");
});

test("integration, outcome, and learning each raise the level", () => {
  const record = baseRecord();
  expect(
    deriveDoneLevel({
      ...record,
      integration: { ref: "commit abc", at: "2026-11-16T12:00:00.000Z" },
    }),
  ).toBe("integrated");
  expect(
    deriveDoneLevel({
      ...record,
      integration: { ref: "commit abc", at: "2026-11-16T12:00:00.000Z" },
      outcome: {
        source: "deploy",
        ref: "deploy-1",
        observed_at: "2026-11-16T12:00:00.000Z",
      },
    }),
  ).toBe("observed");
  expect(
    deriveDoneLevel({
      ...record,
      learning: { ref: "AGENTS.md#records", at: "2026-11-16T12:00:00.000Z" },
    }),
  ).toBe("learned");
});

test("integration does not skip unresolved criteria", () => {
  const record = baseRecord();
  expect(
    deriveDoneLevel({
      ...record,
      criteria: [{ id: "C1", kind: "test", status: "failed", note: "red" }],
      integration: { ref: "commit abc", at: "2026-11-16T12:00:00.000Z" },
    }),
  ).toBe("intended");
});

test("a record with no criteria and no intent is generated", () => {
  const record = baseRecord();
  expect(deriveDoneLevel({ ...record, intent: "", criteria: [] })).toBe("generated");
});
