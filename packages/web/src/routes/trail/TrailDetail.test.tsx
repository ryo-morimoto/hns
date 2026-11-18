import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JsonValue } from "@hns/core";
import { toGlobalId } from "@hns/core/graphql";
import { RelayEnvironmentProvider } from "react-relay";
import { expect, test } from "vitest";
import { createTestEnvironment, type GraphQLCall } from "../../../test/support/relay.ts";
import { TrailDetailScreen } from "./TrailDetailScreen.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const TRAIL = "trail-1";
const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
/** The entity id Relay stores a global id under: the global id, base64-decoded by `relay-runtime`. */
const TRAIL_RECORD_ID = toGlobalId("Trail", TRAIL);

/** One line as the wire carries it. */
interface WireLine {
  readonly __typename: "ReviewLine";
  readonly kind: "CONTEXT" | "ADD" | "DEL";
  readonly text: string;
}

/** The diff as the wire carries it. */
interface WireDiff {
  readonly __typename: "ReviewDiff";
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly added: number;
  readonly removed: number;
  readonly files: readonly {
    readonly __typename: "ReviewFile";
    readonly path: string;
    readonly change: "ADDED" | "DELETED" | "MODIFIED";
    readonly added: number;
    readonly removed: number;
    readonly previewable: boolean;
    readonly hunks: readonly {
      readonly __typename: "ReviewHunk";
      readonly baseStart: number;
      readonly headStart: number;
      readonly lines: readonly WireLine[];
    }[];
  }[];
}

/** One finding as the wire carries it. */
interface WireFinding {
  readonly __typename: "TrailFinding";
  readonly id: string;
  readonly severity: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  readonly source: string;
  readonly status: "OPEN" | "RESOLVED" | "DISMISSED";
  readonly file: string | null;
  readonly hunk: string | null;
  readonly summary: string;
}

/** The trail record the screen's fragment reads. */
interface WireTrail {
  readonly __typename: "Trail";
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly acceptance: string;
  readonly state: string;
  readonly priority: string;
  readonly kind: string;
  readonly updatedAt: string;
  readonly changes: readonly {
    readonly __typename: "TrailChange";
    readonly id: string;
    readonly baseCommit: string;
    readonly headCommit: string;
    readonly state: string;
    readonly diff:
      | WireDiff
      | { readonly __typename: "QueryFailure"; readonly code: string; readonly message: string };
  }[];
  readonly findings: readonly WireFinding[];
  readonly decisions: readonly {
    readonly __typename: "TrailDecision";
    readonly id: string;
    readonly action: "APPROVE" | "REQUEST_CHANGES" | "REJECT";
    readonly actor: string;
    readonly headCommit: string | null;
    readonly note: string;
    readonly at: string;
  }[];
  readonly gates: {
    readonly __typename: "TrailGates";
    readonly line: string;
    readonly lines: readonly {
      readonly __typename: "TrailGateLine";
      readonly gate: "HUMAN_REVIEW" | "TESTS" | "FINDINGS" | "FRESHNESS";
      readonly status: "PENDING" | "PASS" | "FAIL" | "ASK";
      readonly detail: string;
    }[];
  };
  readonly sessions: readonly {
    readonly __typename: "TrailSession";
    readonly id: string;
    readonly conversationId: string | null;
  }[];
}

/** The one diff the screen renders: a modified text file and a binary one. */
const DIFF: WireDiff = {
  __typename: "ReviewDiff",
  baseCommit: BASE,
  headCommit: HEAD,
  added: 2,
  removed: 1,
  files: [
    {
      __typename: "ReviewFile",
      path: "src/app.ts",
      change: "MODIFIED",
      added: 2,
      removed: 1,
      previewable: true,
      hunks: [
        {
          __typename: "ReviewHunk",
          baseStart: 1,
          headStart: 1,
          lines: [
            { __typename: "ReviewLine", kind: "CONTEXT", text: "const a = 1;" },
            { __typename: "ReviewLine", kind: "ADD", text: "const b = 2;" },
            { __typename: "ReviewLine", kind: "DEL", text: "const c = 0;" },
          ],
        },
      ],
    },
    {
      __typename: "ReviewFile",
      path: "logo.png",
      change: "MODIFIED",
      added: 0,
      removed: 0,
      previewable: false,
      hunks: [],
    },
  ],
};

/** A high open finding and a low one, which is what the default list has to tell apart. */
const FINDINGS: readonly WireFinding[] = [
  {
    __typename: "TrailFinding",
    id: toGlobalId("TrailFinding", "finding-high"),
    severity: "HIGH",
    source: "AGENT",
    status: "OPEN",
    file: "src/app.ts",
    hunk: "@@ -1,1 +1,2 @@",
    summary: "the retry loops forever",
  },
  {
    __typename: "TrailFinding",
    id: toGlobalId("TrailFinding", "finding-low"),
    severity: "LOW",
    source: "HUMAN",
    status: "OPEN",
    file: null,
    hunk: null,
    summary: "rename the helper",
  },
];

/** The gates a Trail with a high finding and no approval has. */
const BLOCKED_GATES: WireTrail["gates"] = {
  __typename: "TrailGates",
  line:
    "merge: blocked — human_review (not approved at " +
    HEAD +
    "); findings (1 high finding(s) open); tests (no test evidence is recorded on this Trail)",
  lines: [
    {
      __typename: "TrailGateLine",
      gate: "HUMAN_REVIEW",
      status: "FAIL",
      detail: "not approved at " + HEAD,
    },
    {
      __typename: "TrailGateLine",
      gate: "TESTS",
      status: "ASK",
      detail: "no test evidence is recorded on this Trail",
    },
    {
      __typename: "TrailGateLine",
      gate: "FINDINGS",
      status: "FAIL",
      detail: "1 high finding(s) open",
    },
    {
      __typename: "TrailGateLine",
      gate: "FRESHNESS",
      status: "PASS",
      detail: "the base the Change names is still the base",
    },
  ],
};

/** The Trail the screen reads. */
function trailRecord(overrides: Partial<WireTrail> = {}): WireTrail {
  return {
    __typename: "Trail",
    id: TRAIL_RECORD_ID,
    title: "The review face",
    description: "read a change",
    acceptance: "the diff is readable",
    state: "ACTIVE",
    priority: "NORMAL",
    kind: "FEATURE",
    updatedAt: "2026-11-18T00:00:00.000Z",
    changes: [
      {
        __typename: "TrailChange",
        id: toGlobalId("TrailChange", "change-1"),
        baseCommit: BASE,
        headCommit: HEAD,
        state: "OPEN",
        diff: DIFF,
      },
    ],
    findings: FINDINGS,
    decisions: [],
    gates: BLOCKED_GATES,
    sessions: [],
    ...overrides,
  };
}

/**
 * A responder that answers the screen's mutations.
 *
 * @param decisions - Where each decision's input is recorded.
 * @returns The answer for a call, or undefined for a request no test expects.
 *
 * @remarks
 * The environment names a query after its `query <name>` line; a mutation after the same line in
 * the compiled document, which the test support now reads as well.
 */
function answerOf(decisions: JsonValue[]): (call: GraphQLCall) => JsonValue | undefined {
  return (call) => {
    if (call.operation === "TrailDetailDecideMutation") {
      decisions.push(call.variables["input"] ?? null);
      return {
        decideTrail: {
          __typename: "DecideTrailPayload",
          decision: {
            __typename: "TrailDecision",
            id: toGlobalId("TrailDecision", "decision-1"),
            action: "REQUEST_CHANGES",
            headCommit: HEAD,
          },
          nextRunInput:
            "Review findings to address (head " +
            HEAD +
            "):\n- [high] src/app.ts @@ -1,1 +1,2 @@: the retry loops forever",
        },
      };
    }
    return undefined;
  };
}

/**
 * Render the review face over the test environment.
 *
 * @param trail - The Trail the detail read answers.
 * @param decisions - Where each decision's input is recorded.
 *
 * @remarks
 * The screen is rendered through its route screen, so the read, the fragments, and the queries
 * are the compiled ones the app ships; the only replacement is the network, which answers from
 * the fixture. A DOM test that rendered the fragment alone would not prove the document.
 */
function renderTrail(trail: WireTrail, decisions: JsonValue[] = []) {
  const { environment, calls } = createTestEnvironment((call) => {
    if (call.operation === "TrailDetailQuery") {
      // SAFETY: the fixture is the face's published shape for the read (strings, numbers, arrays,
      // and objects), which is the JSON a GraphQL body parses to; the interface has no index
      // signature, and this is the one step from it to the body.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions
      return { trail: { __typename: "TrailPayload", trail } } as unknown as JsonValue;
    }
    return answerOf(decisions)(call);
  });
  render(
    <RelayEnvironmentProvider environment={environment}>
      <TrailDetailScreen trailId={TRAIL} />
    </RelayEnvironmentProvider>,
  );
  return { environment, calls };
}

/**
 * C1: the Change is drawn as files, hunks, and lines.
 *
 * @remarks
 * Catches a screen that shows the commit pair but not the diff, a hunk flattened into one block
 * with no line kinds, and a binary file silently dropped: it has to say "changed, not
 * previewable" rather than disappear or print replacement characters.
 */
test("C1: a change renders its file, hunk, and lines, and a binary file is not previewable", async () => {
  renderTrail(trailRecord());
  await screen.findByRole("heading", { name: "The review face" });

  const file = document.querySelector('[data-path="src/app.ts"]');
  expect(file).not.toBeNull();
  const lines = [...(file?.querySelectorAll("[data-line-kind]") ?? [])];
  expect(lines.map((line) => line.getAttribute("data-line-kind"))).toStrictEqual([
    "context",
    "add",
    "del",
  ]);
  expect(lines.map((line) => line.textContent)).toStrictEqual([
    " const a = 1;",
    "+const b = 2;",
    "-const c = 0;",
  ]);
  expect(file?.textContent).toContain("@@ -1 +1 @@");
  const binary = document.querySelector('[data-path="logo.png"]');
  expect(binary?.textContent).toContain("変更あり（プレビュー不可）");
});

/**
 * C1: a diff the server could not read is said, not drawn as an empty change.
 *
 * @remarks
 * Catches a failure member rendered as "0 files": a reviewer would read that as "nothing changed",
 * the one answer a review must not give for a read it could not make.
 */
test("C1: a diff that could not be read says so instead of showing an empty change", async () => {
  renderTrail(
    trailRecord({
      changes: [
        {
          __typename: "TrailChange",
          id: toGlobalId("TrailChange", "change-2"),
          baseCommit: BASE,
          headCommit: "3".repeat(40),
          state: "OPEN",
          diff: { __typename: "QueryFailure", code: "NOT_FOUND", message: "no checkpoint pack" },
        },
      ],
    }),
  );
  expect(await screen.findByText(/差分を読めません: NOT_FOUND/u)).toBeTruthy();
});

/**
 * C3: the gate line is the server's sentence, and each gate is beside it with its reason.
 *
 * @remarks
 * Catches a screen that recomposes the line (and so can say what the gate does not), and one that
 * shows a gate without the reason it holds.
 */
test("the gate line and each gate's reason are on screen", async () => {
  renderTrail(trailRecord());
  await screen.findByRole("heading", { name: "The review face" });
  const line = document.querySelector("[data-gate-line]");
  expect(line?.textContent).toBe(BLOCKED_GATES.line);
  const statuses = [...document.querySelectorAll(".hns-review__gate")].map((gate) =>
    gate.getAttribute("data-status"),
  );
  expect(statuses).toStrictEqual(["FAIL", "ASK", "FAIL", "PASS"]);
  expect(screen.getByText("1 high finding(s) open")).toBeTruthy();
});

/**
 * The finding list shows blocking points by default, and the rest on request.
 *
 * @remarks
 * Catches a first screen that buries the blocking point under notes, and a toggle that shows the
 * blocking one twice.
 */
test("findings default to blocking only, and the toggle shows the rest", async () => {
  renderTrail(trailRecord());
  expect(await screen.findByText("the retry loops forever")).toBeTruthy();
  expect(screen.queryByText("rename the helper")).toBe(null);
  await userEvent.click(screen.getByRole("button", { name: "すべての指摘 (2)" }));
  expect(screen.getByText("rename the helper")).toBeTruthy();
});

/**
 * C2 / C4: approve names the head on screen, and a revise shows the next Run's input.
 *
 * @remarks
 * Catches an approve that sends no head (which could never go stale), one that sends a head the
 * screen did not read, and a revise whose points the screen drops instead of showing what the
 * server says the next Run starts with.
 */
test("approve sends the head on screen, and a revise shows what the next Run is given", async () => {
  const decisions: JsonValue[] = [];
  renderTrail(trailRecord({ findings: [] }), decisions);
  await screen.findByRole("heading", { name: "The review face" });

  await userEvent.click(screen.getByRole("button", { name: "承認" }));
  await waitFor(
    () => {
      const alert = document.querySelector("[role=alert]");
      expect(alert?.textContent ?? null).toBe(null);
      expect(decisions).toHaveLength(1);
    },
    { timeout: 2000 },
  );
  expect(decisions[0]).toMatchObject({ action: "APPROVE", headCommit: HEAD });

  await userEvent.click(screen.getByRole("button", { name: "修正を依頼" }));
  await waitFor(() => {
    expect(decisions).toHaveLength(2);
  });
  expect(decisions[1]).toMatchObject({ action: "REQUEST_CHANGES", headCommit: HEAD });
  expect(screen.getByText(/Review findings to address/u)).toBeTruthy();
});

/**
 * C2: an approval of this head is shown, and an approval of another head is not.
 *
 * @remarks
 * Catches a sentence that says "approved" for a head that moved: the record still has the
 * approval (it is append-only), and the screen must not read it as in force.
 */
test("C2: the screen says approved only for the head it holds", async () => {
  const decisions = (head: string): WireTrail["decisions"] => [
    {
      __typename: "TrailDecision",
      id: toGlobalId("TrailDecision", "approval-1"),
      action: "APPROVE",
      actor: "owner",
      headCommit: head,
      note: "",
      at: "2026-11-18T00:00:00.000Z",
    },
  ];
  renderTrail(trailRecord({ decisions: decisions(HEAD), findings: [] }));
  expect(await screen.findByText(/承認済み: /u)).toBeTruthy();
  cleanup();
  renderTrail(trailRecord({ decisions: decisions(BASE), findings: [] }));
  expect(await screen.findByText("この head への承認はありません。")).toBeTruthy();
});

/**
 * A Trail with no change cannot be approved, and says so.
 *
 * @remarks
 * Catches an approve button that is enabled with no head: the face would refuse the request, and
 * a screen that offers it has asked for a certainty it does not have.
 */
test("with no change, approve is disabled and the screen says nothing names a head", async () => {
  renderTrail(
    trailRecord({
      changes: [],
      findings: [],
      gates: {
        __typename: "TrailGates",
        line: "merge: blocked — human_review (no Change to approve); tests (no test evidence is recorded on this Trail); freshness (no Change to compare with the base)",
        lines: [
          {
            __typename: "TrailGateLine",
            gate: "HUMAN_REVIEW",
            status: "FAIL",
            detail: "no Change to approve",
          },
          {
            __typename: "TrailGateLine",
            gate: "TESTS",
            status: "ASK",
            detail: "no test evidence is recorded on this Trail",
          },
          {
            __typename: "TrailGateLine",
            gate: "FINDINGS",
            status: "PASS",
            detail: "no high finding is open",
          },
          {
            __typename: "TrailGateLine",
            gate: "FRESHNESS",
            status: "ASK",
            detail: "no Change to compare with the base",
          },
        ],
      },
    }),
  );
  await screen.findByRole("heading", { name: "The review face" });
  expect(screen.getByRole("button", { name: "承認" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("承認する変更がありません。")).toBeTruthy();
});
