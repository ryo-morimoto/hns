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
  // Listed because the type demands every seam, and then **excluded from the check**: the
  // production table's `office` is the face's own forwarder (`worker.ts`), which is the preview
  // route's production wiring, not a substitution. The seam of that name is on the object's
  // dependencies, and the dependency of that name is on the face's table.
  office: true,
  open: true,
  cost: true,
};

/**
 * The names the check below skips, and why.
 *
 * @remarks
 * `office` is one name for two things: the **seam** on `SessionDependencies` (a test supplies an
 * office face) and the **production dependency** on `HandlerDependencies` (the edge's own
 * forwarder for `GET /api/office/preview`, from `worker.ts`). The production table must carry the
 * second, so the name is present there while the seam is not. The consequence: this test cannot
 * tell the seam from the dependency by name, so a seam named `office` that reached
 * `SessionDependencies` would not be caught here — the object's own open path is what keeps it
 * from being substituted in production.
 */
const SEAMS_EXEMPT: ReadonlySet<string> = new Set(["office"]);

test("the production Worker's dependency table carries no seam", () => {
  for (const seam of Object.keys(SEAMS)) {
    if (SEAMS_EXEMPT.has(seam)) continue;
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
