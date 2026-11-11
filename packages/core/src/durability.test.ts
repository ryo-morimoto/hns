import { expect, test } from "vitest";
import { DURABILITY_AUTHORITIES, FAILURE_CLASSES } from "./durability.ts";
import type {
  CheckpointRef,
  DurableUnit,
  DurabilityAuthority,
  FailureClass,
} from "./durability.ts";

// Catches: the exported failure vocabulary changing without a contract review.
test("the durability contract names the four failure classes", () => {
  const expected: readonly FailureClass[] = [
    "process-crash",
    "power-loss",
    "machine-loss",
    "account-incident",
  ];
  expect(FAILURE_CLASSES).toStrictEqual(expected);
});

// Catches: the exported authority list changing without a contract review.
test("only the two DOs and R2 hold the authoritative copy", () => {
  const expected: readonly DurabilityAuthority[] = ["session-do", "workspace-do", "r2"];
  expect(DURABILITY_AUTHORITIES).toStrictEqual(expected);
});

// Compile-time proof only: the contract has no runtime behavior yet.
const checkpoint: CheckpointRef = {
  workspaceId: "workspace-1",
  runId: "run-1",
  commit: "0123456789abcdef",
};
const durableUnit: DurableUnit = { checkpoint, throughSeq: 7 };
void durableUnit;
