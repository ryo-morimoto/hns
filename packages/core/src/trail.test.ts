import { expect, test } from "vitest";
import {
  TRAIL_STATES,
  TRAIL_TRANSITIONS_FOR_TEST,
  canTrailTransition,
  isTrailOpen,
  trailStateWithFirstChange,
} from "./trail.ts";
import type { TrailState } from "./trail.ts";

// The expected table, written out rather than read from the module: a test that imports the
// implementation's own table would agree with any edit to it.
const EXPECTED: Readonly<Record<TrailState, readonly TrailState[]>> = {
  draft: ["active", "abandoned"],
  active: ["in_review", "abandoned"],
  in_review: ["active", "merged", "abandoned"],
  merged: ["observing"],
  observing: ["active", "closed"],
  closed: [],
  abandoned: [],
};

// Catches: a transition added or removed without the table being the thing a reader checks.
test("the Trail transition table is the one the model names", () => {
  expect(TRAIL_TRANSITIONS_FOR_TEST).toStrictEqual(EXPECTED);
});

// Catches: a state that has no row in the table, which would make every move out of it fail closed
// by accident rather than by decision.
test("every Trail state has a row, so the table is exhaustive over the union", () => {
  expect(Object.keys(TRAIL_TRANSITIONS_FOR_TEST).sort()).toStrictEqual([...TRAIL_STATES].sort());
});

// Catches: the first change leaving a draft in draft, which would make a Trail that has a change
// still look like intent only (trail-model-v1 §1.2).
test("the first change moves a draft to active", () => {
  expect(trailStateWithFirstChange("draft")).toBe("active");
});

// Catches: adding a change to a live Trail moving it by itself, which would bypass the review the
// Trail's own transition needs.
test("a first change leaves every state other than draft where it was", () => {
  for (const state of TRAIL_STATES) {
    if (state === "draft") continue;
    expect(trailStateWithFirstChange(state), state).toBe(state);
  }
});

// Catches: a terminal state that is reported as open, which would let a reader keep a closed
// Trail in an active list.
test("only closed and abandoned are ended", () => {
  expect(TRAIL_STATES.filter((state) => !isTrailOpen(state))).toStrictEqual([
    "closed",
    "abandoned",
  ]);
});

// Catches: a state added to the union without a decision about whether it tracks, and a value
// that bypassed the union (a hand-edited row) read as a default.
test("an unknown state throws rather than reading as a default", () => {
  // SAFETY: a stored row can hold text the type does not admit; the reader must fail closed.
  const hostile = "blocked" as TrailState;
  expect(() => isTrailOpen(hostile)).toThrow(/unexpected trail state/u);
  expect(() => trailStateWithFirstChange(hostile)).toThrow(/unexpected trail state/u);
});

// Catches: a move the diagram allows being refused — the forward path, the change request, and
// the abandon from every live state.
test.each(
  TRAIL_STATES.flatMap((from) =>
    TRAIL_STATES.filter((to) => EXPECTED[from].includes(to)).map((to) => [from, to] as const),
  ),
)("every legal move is allowed: %s -> %s", (from, to) => {
  expect(canTrailTransition(from, to)).toBe(true);
});

// Catches: a move the diagram does not draw being allowed — every pair not in the table.
test.each(
  TRAIL_STATES.flatMap((from) =>
    TRAIL_STATES.filter((to) => !EXPECTED[from].includes(to) && to !== from).map(
      (to) => [from, to] as const,
    ),
  ),
)("every other move is refused: %s -> %s", (from, to) => {
  expect(canTrailTransition(from, to)).toBe(false);
});

// Catches: a state that can stay where it is through the transition function, which would make
// "it moved" indistinguishable from "nothing happened".
test("a state does not transition to itself", () => {
  for (const state of TRAIL_STATES) expect(canTrailTransition(state, state), state).toBe(false);
});

// Catches: the refusal case the issue names — a merged Trail must not be abandoned.
test("a merged Trail cannot be abandoned", () => {
  expect(canTrailTransition("merged", "abandoned")).toBe(false);
});
