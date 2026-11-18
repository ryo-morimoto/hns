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

/**
 * The names `SessionDependencies` declares: every one is a substitution of a host or runtime.
 *
 * @remarks
 * **The compiler keeps this list complete.** A key added to `SessionDependencies` makes this
 * record fail to type-check — `Record<keyof SessionDependencies, true>` demands the new key — so
 * a new seam cannot reach the entry without this list being edited in the same commit. (A
 * runtime list derived from the type is not possible: a type has no keys at run time, and a
 * `keyof`-typed array alone does not check that it is *exhaustive*.) The value is `true` because
 * the record is only a set of names; the test reads `Object.keys`.
 */
const SEAMS: Record<keyof SessionDependencies, true> = {
  webSocketPair: true,
  now: true,
  upgradeResponse: true,
  machineFetch: true,
  officeAgentUrl: true,
  // The compiler requires this key (the type demands every seam), and the test below reads what
  // it means: the production table's `office` is the **face's own forwarder** (`worker.ts`), so
  // the name is present there while the seam this key names is not. The two live on different
  // tables (`SessionDependencies` has the seam; `HandlerDependencies` has the dependency), and
  // `SEAMS_EXEMPT` is where the test records that a name can mean both.
  office: true,
  open: true,
  cost: true,
};

test("the production Worker's dependency table carries no seam", () => {
  for (const seam of Object.keys(SEAMS)) {
    // `office` is the face's own forwarder in the table, not the seam: it is the production
    // wiring of the preview route, and the seam of that name lives on the object's dependencies.
    if (seam === "office") continue;
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
