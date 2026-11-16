import * as v from "valibot";
import { expect, test } from "vitest";

import { baseRecord } from "../test/support/records.ts";
import { validateRecord, workRecordSchema } from "./schema.ts";

test("a complete record parses", () => {
  const parsed = v.safeParse(workRecordSchema, baseRecord());
  expect(parsed.success).toBe(true);
});

test("duplicate criterion ids are rejected", () => {
  const record = baseRecord();
  const parsed = v.safeParse(workRecordSchema, {
    ...record,
    criteria: [
      { id: "C1", kind: "test", status: "passed", evidence: "a" },
      { id: "C1", kind: "manual", status: "passed", evidence: "b" },
    ],
  });
  expect(parsed.success).toBe(false);
});

test("an unknown outcome source is rejected", () => {
  const record = baseRecord();
  const parsed = v.safeParse(workRecordSchema, {
    ...record,
    outcome: {
      source: "spreadsheet",
      ref: "sheet-1",
      observed_at: "2026-11-16T12:00:00.000Z",
    },
  });
  expect(parsed.success).toBe(false);
});

test("a passed criterion without evidence is rejected", () => {
  const record = baseRecord();
  const issues = validateRecord({
    ...record,
    criteria: [{ id: "C1", kind: "test", status: "passed" }],
  });
  expect(issues.map((issue) => issue.message)).toContain("passed needs evidence");
});

test("whitespace-only required text is rejected", () => {
  const record = baseRecord();
  expect(v.safeParse(workRecordSchema, { ...record, intent: "   " }).success).toBe(false);
  expect(v.safeParse(workRecordSchema, { ...record, limits: ["  "] }).success).toBe(false);
});

test("a waived criterion needs a note", () => {
  const record = baseRecord();
  const issues = validateRecord({
    ...record,
    criteria: [{ id: "C1", kind: "manual", status: "waived" }],
  });
  expect(issues.map((issue) => issue.message)).toContain("waived needs a note");
});
