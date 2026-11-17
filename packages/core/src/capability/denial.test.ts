import * as v from "valibot";
import { expect, test } from "vitest";
import { denialOf, deny, retryOf } from "./denial.ts";
import { DenialCodeSchema } from "./schemas.ts";
import { DENIAL_CODES, DENIAL_RETRY } from "./types.ts";
import type { DenialCode } from "./types.ts";

// Catches: a code added to the union while a consumer (or the retry table) silently falls through.
test("every denial code has a retry and ends a switch in never", () => {
  const seen: DenialCode[] = [];
  for (const code of DENIAL_CODES) {
    expect(v.parse(DenialCodeSchema, code)).toBe(code);
    switch (code) {
      case "policy_denied":
      case "tool_disabled":
      case "scope_exceeded":
      case "manifest_mismatch":
      case "grant_invalid":
      case "grant_expired":
      case "grant_revoked":
      case "grant_algorithm_mismatch":
      case "grant_replayed":
      case "counter_exhausted":
      case "epoch_stale":
      case "path_outside_root":
      case "command_not_allowed":
      case "egress_denied":
      case "approval_stale":
      case "unsupported":
        seen.push(code);
        break;
      default: {
        const unreached: never = code;
        throw new Error("a denial code without a branch: " + String(unreached));
      }
    }
  }
  expect(seen).toStrictEqual([...DENIAL_CODES]);
});

// Catches: an expiry and a revocation collapsed into one code, so an audit cannot tell a grant that
// ran out from one the issuer took back while it was still live.
test("an expiry and a revocation are different codes, and only the expiry is retryable", () => {
  expect(DENIAL_CODES).toContain("grant_revoked");
  expect(retryOf("grant_expired")).toBe("retry");
  expect(retryOf("grant_revoked")).toBe("never");
});

// Catches: a retry table that drifts from docs/capability.md §7, so a model is told an unrecoverable
// denial is retryable (or the reverse).
test("the retry table is the one the contract documents", () => {
  expect(DENIAL_RETRY).toStrictEqual({
    policy_denied: "propose",
    tool_disabled: "never",
    scope_exceeded: "never",
    manifest_mismatch: "never",
    grant_invalid: "never",
    grant_expired: "retry",
    grant_revoked: "never",
    grant_algorithm_mismatch: "never",
    grant_replayed: "never",
    counter_exhausted: "never",
    epoch_stale: "retry",
    path_outside_root: "never",
    command_not_allowed: "never",
    egress_denied: "never",
    approval_stale: "retry",
    unsupported: "never",
  });
  expect(Object.keys(DENIAL_RETRY).sort()).toStrictEqual([...DENIAL_CODES].sort());
  for (const code of DENIAL_CODES) expect(retryOf(code)).toBe(DENIAL_RETRY[code]);
});

// Catches: a denial that is thrown instead of returned, or one that loses the revision it was
// decided against.
test("a denial is a value that carries its code and the policy it was decided against", () => {
  expect(deny("scope_exceeded", "outside")).toStrictEqual({
    outcome: "deny",
    code: "scope_exceeded",
    message: "outside",
  });
  const decision = deny("epoch_stale", "stale", { revision: 4, hash: "a".repeat(64) });
  expect(decision).toMatchObject({ outcome: "deny", code: "epoch_stale", policyRevision: 4 });
  expect(denialOf(decision)).toBe("epoch_stale");
  expect(denialOf({ outcome: "allow", policyRevision: 1, policyHash: "b".repeat(64) })).toBeNull();
});
