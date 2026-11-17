import { expect, expectTypeOf, test } from "vitest";
import { isoTimestamp } from "@hns/core";
import type { MirrorState } from "@hns/core";
import { fitsMirrorLimits, mirrorRef, reviewSourceFor } from "./mirror.ts";

/**
 * The mirror's pure rules (0246).
 *
 * The push is a git process and is tested over a real remote in `test/integration/mirror.test.ts`;
 * what is here is what the Worker (which issues the ref) and a reader (which picks the review
 * source) decide without touching a network.
 */

const at = isoTimestamp("2026-11-18T00:00:00.000Z");

// Catches: a review read from Artifacts for a run whose push did not land, or a fallback that
// ignores a run too large to mirror.
test("only a mirrored run is reviewed from Artifacts", () => {
  const source = (status: MirrorState["status"], failure?: MirrorState["failure"]) =>
    reviewSourceFor(
      failure === undefined ? { status, updatedAt: at } : { status, failure, updatedAt: at },
    );
  expect(source("mirrored")).toBe("artifacts");
  expect(source("pending")).toBe("machine");
  expect(source("failed", "network")).toBe("machine");
  expect(source("skipped", "too_large")).toBe("machine");
  expectTypeOf(reviewSourceFor).returns.toEqualTypeOf<"artifacts" | "machine">();
});

// Catches: a ref under a private namespace (which the binding cannot resolve and a fork does not
// carry), or a ref that collides with a user's branch or escapes the Run's name.
test("a Run's mirror ref is a branch under hns/run", () => {
  expect(mirrorRef("run-1")).toBe("refs/heads/hns/run/run-1");
  expect(mirrorRef("Run_2.a-b")).toBe("refs/heads/hns/run/Run_2.a-b");
  for (const runId of ["", "/run-1", "run-1/x", "..", "run-1.lock", "run-1.", "a b", "-lead"]) {
    expect(() => mirrorRef(runId), runId).toThrow(RangeError);
  }
  // Every ref is a branch: the one shape Artifacts' binding resolves and a fork carries.
  expect(mirrorRef("run-1").startsWith("refs/heads/")).toBe(true);
});

// Catches: the mirror's limits drifting from the checkpoint contract's (a second 32 MiB).
test("the mirror's limits are the contract's 32 MiB file and 64 MiB pack", () => {
  expect(fitsMirrorLimits(64 * 1024 * 1024, 32 * 1024 * 1024)).toBe(true);
  expect(fitsMirrorLimits(64 * 1024 * 1024 + 1, 0)).toBe(false);
  expect(fitsMirrorLimits(1, 32 * 1024 * 1024 + 1)).toBe(false);
});
