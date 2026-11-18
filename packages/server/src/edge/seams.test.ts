import { expect, test } from "vitest";
import type { SessionDependencies } from "../do/session.ts";
import { dependencies } from "./worker.ts";

/**
 * (0119) The production entry carries no seam.
 *
 * @remarks
 * `SessionDependencies` has seams a test injects (`open`, `machineFetch`, the socket pair), and the
 * Worker's table is what a deployment actually runs. If a seam reached the entry, production would
 * serve whatever that stand-in answered; this pins the entry to the product's own dependencies.
 *
 * The test reads the **exported table**, not a re-declaration, so adding a seam to the entry fails
 * here before it fails in a deployment.
 */

/** The names `SessionDependencies` declares: every one is a substitution of a host or runtime. */
const SEAMS: readonly (keyof SessionDependencies)[] = [
  "webSocketPair",
  "now",
  "upgradeResponse",
  "machineFetch",
  "open",
];

test("the production Worker's dependency table carries no seam", () => {
  for (const seam of SEAMS) {
    expect(dependencies).not.toHaveProperty(seam);
  }
});

// Catches: a face (0119's conversations among them) that the entry leaves unwired.
test("the production Worker wires every face it serves", () => {
  expect(dependencies.graphql).toBeTypeOf("function");
  expect(dependencies.ws).toBeTypeOf("function");
  expect(dependencies.obs).toBeTypeOf("function");
  expect(dependencies.files).toBeTypeOf("function");
  expect(dependencies.checkpoints).toBeTypeOf("function");
  expect(dependencies.machineKeys).toBeTypeOf("function");
  expect(dependencies.conversations).toBeTypeOf("function");
});
