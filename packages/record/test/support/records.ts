import type { WorkRecord } from "../../src/types.ts";

export const baseRecord = (): WorkRecord => ({
  schema: 1,
  issue: "0200",
  intent: "reviewers can see what changed and what it proves",
  criteria: [
    { id: "C1", kind: "test", status: "passed", evidence: "npm test -w @hns/record" },
    { id: "C2", kind: "manual", status: "passed", evidence: "review PASS" },
  ],
  limits: ["performance is not measured"],
  decision: { by: "user", at: "2026-11-16T12:00:00.000Z", basis: "criteria and evidence reviewed" },
  invalidation: ["record schema changes"],
});
