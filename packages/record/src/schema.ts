import { IsoTimestampSchema } from "@hns/core";
import * as v from "valibot";

import { CRITERION_KINDS, CRITERION_STATUSES, OUTCOME_SOURCES } from "./types.ts";
import type { Criterion, Decision, Integration, Learning, Outcome, WorkRecord } from "./types.ts";

/** One validation finding, with a dotted path into the record. */
export interface RecordIssue {
  /** Where the problem is. Slash when the document itself is invalid. */
  readonly path: string;
  /** What is wrong, in one sentence. */
  readonly message: string;
}

const boundedText = (max: number): v.GenericSchema<string, string> =>
  v.pipe(
    v.string(),
    v.check((value) => value.trim() !== "", "must not be empty"),
    v.maxLength(max),
  );

const uniqueIds = (items: Criterion[]): boolean => {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
  }
  return true;
};

/** The schema for one acceptance criterion. */
export const criterionSchema: v.GenericSchema<unknown, Criterion> = v.strictObject({
  id: v.pipe(v.string(), v.regex(/^[A-Za-z0-9-]+$/u, "letters, digits, dash"), v.maxLength(40)),
  kind: v.picklist(CRITERION_KINDS),
  status: v.picklist(CRITERION_STATUSES),
  evidence: v.optional(boundedText(1000)),
  note: v.optional(boundedText(1000)),
});

/** The schema for who accepted the work. */
export const decisionSchema: v.GenericSchema<unknown, Decision> = v.strictObject({
  by: boundedText(120),
  at: IsoTimestampSchema,
  basis: boundedText(1000),
});

/** The schema for where the change became live. */
export const integrationSchema: v.GenericSchema<unknown, Integration> = v.strictObject({
  ref: boundedText(500),
  at: IsoTimestampSchema,
});

/** The schema for one observed outcome. */
export const outcomeSchema: v.GenericSchema<unknown, Outcome> = v.strictObject({
  source: v.picklist(OUTCOME_SOURCES),
  ref: boundedText(500),
  observed_at: IsoTimestampSchema,
  note: v.optional(boundedText(1000)),
  confidence: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
});

/** The schema for where the learning was written. */
export const learningSchema: v.GenericSchema<unknown, Learning> = v.strictObject({
  ref: boundedText(500),
  at: IsoTimestampSchema,
});

/** The schema for one work record. */
export const workRecordSchema: v.GenericSchema<unknown, WorkRecord> = v.strictObject({
  schema: v.literal(1),
  issue: v.pipe(v.string(), v.regex(/^\d{4}$/u, "must be four digits")),
  intent: boundedText(2000),
  criteria: v.pipe(
    v.array(criterionSchema),
    v.minLength(1, "at least one criterion"),
    v.maxLength(50),
    v.check(uniqueIds, "criterion ids must be unique"),
  ),
  limits: v.pipe(v.array(boundedText(500)), v.minLength(1, "at least one limit"), v.maxLength(20)),
  decision: decisionSchema,
  invalidation: v.pipe(
    v.array(boundedText(500)),
    v.minLength(1, "at least one invalidation"),
    v.maxLength(20),
  ),
  integration: v.optional(integrationSchema),
  outcome: v.optional(outcomeSchema),
  learning: v.optional(learningSchema),
});

/**
 * Check the rules that span fields.
 *
 * @remarks
 * A passed criterion needs evidence; a waived criterion needs a reason. Both are what make
 * the record usable by a reviewer instead of a claim.
 * @param record - A schema-valid record.
 * @returns Every violation, or an empty array.
 */
export const validateRecord = (record: WorkRecord): readonly RecordIssue[] => {
  const issues: RecordIssue[] = [];
  record.criteria.forEach((criterion, index) => {
    if (
      criterion.status === "passed" &&
      (criterion.evidence === undefined || criterion.evidence.trim() === "")
    ) {
      issues.push({
        path: "criteria." + String(index) + ".evidence",
        message: "passed needs evidence",
      });
    }
    if (
      criterion.status === "waived" &&
      (criterion.note === undefined || criterion.note.trim() === "")
    ) {
      issues.push({ path: "criteria." + String(index) + ".note", message: "waived needs a note" });
    }
  });
  return issues;
};
