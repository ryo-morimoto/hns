import { expect, test } from "vitest";
import { isoTimestamp } from "./codecs.ts";
import { LEASE_REFUSALS } from "./lease.ts";
import type { LeaseRefusal, WorkspaceLease } from "./lease.ts";

// Catches: a refusal being renamed or dropped without a contract review.
test("the lease contract names its three refusals", () => {
  const expected: readonly LeaseRefusal[] = [
    "lease_not_held",
    "lease_expired",
    "lease_epoch_stale",
  ];
  expect(LEASE_REFUSALS).toStrictEqual(expected);
});

// Compile-time proof only: the contract has no runtime behavior yet.
const lease: WorkspaceLease = {
  workspaceId: "workspace-1",
  machineId: "machine-1",
  epoch: 1,
  expiresAt: isoTimestamp("2026-11-17T00:00:00.000Z"),
};
void lease;
