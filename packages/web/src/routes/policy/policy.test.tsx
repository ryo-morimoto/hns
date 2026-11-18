import {
  buildSchema,
  execute,
  parse,
  validate,
  type ExecutionResult,
  GraphQLEnumType,
  type GraphQLNamedType,
  type GraphQLSchema,
} from "graphql";
import type { JsonValue } from "@hns/core";
import { toGlobalId } from "@hns/core/graphql";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import { RelayEnvironmentProvider } from "react-relay";
import { Environment, Network, RecordSource, Store, type GraphQLResponse } from "relay-runtime";
import * as v from "valibot";
import { expect, test } from "vitest";
import { PolicyScreen } from "./PolicyScreen.tsx";
import decideOperation from "../../__generated__/PolicyScreenDecideMutation.graphql.ts";
import proposeOperation from "../../__generated__/PolicyScreenProposeMutation.graphql.ts";
import queryOperation from "../../__generated__/PolicyScreenQuery.graphql.ts";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** The workspace the screen is bound to, as the route passes it. */
const WORKSPACE_ID = toGlobalId("Project", "project-policy");
const PROPOSAL_ONE = toGlobalId("PolicyProposal", "proposal-1");

/** The compiled operations, typed by the module that holds them. */
type QueryOperation = typeof queryOperation;
type MutationOperation = typeof decideOperation | typeof proposeOperation;
type Operation = QueryOperation | MutationOperation;

/** One capability atom as the wire carries it. */
interface WireAtom {
  readonly __typename: "PolicyDiffAtom";
  readonly atomKind: string;
  readonly value: string;
}

/** A diff as the wire carries it. */
interface WireDiff {
  readonly __typename: "PolicyDiff";
  readonly kind: string;
  readonly added: readonly WireAtom[];
  readonly removed: readonly WireAtom[];
}

/** A policy document as the wire carries it. */
interface WireDocument {
  readonly __typename: "PolicyDocument";
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  readonly bash: boolean;
  readonly network: boolean;
}

/** A revision as the wire carries it. */
interface WireRevision {
  readonly __typename: "PolicyRevision";
  readonly id: string;
  readonly revision: number;
  readonly hash: string;
  readonly active: boolean;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly document: WireDocument;
}

/** A proposal as the wire carries it. */
interface WireProposal {
  readonly __typename: "PolicyProposal";
  readonly id: string;
  readonly baseRevision: number;
  readonly reviewToken: string;
  readonly status: "PENDING" | "APPROVED" | "REJECTED";
  readonly requestedBy: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly candidate: WireDocument;
  readonly diff: WireDiff;
}

/** A revision list (`policyRevisions`'s success member). */
interface WireRevisionList {
  readonly __typename: "PolicyRevisionList";
  readonly revisions: readonly WireRevision[];
}

/** A proposal list (`policyProposals`'s success member). */
interface WireProposalList {
  readonly __typename: "PolicyProposalList";
  readonly proposals: readonly WireProposal[];
}

/** A refusal either query can answer. */
interface WireFailure {
  readonly __typename: "PolicyFailure";
  readonly code: string;
  readonly message: string;
}

/** The screen's query answer. */
interface WireQueryData {
  readonly policyRevisions: WireRevisionList | WireFailure;
  readonly policyProposals: WireProposalList | WireFailure;
}

/** A decision's answer. */
interface WireDecideData {
  readonly decidePolicy:
    | {
        readonly __typename: "DecidePolicyPayload";
        readonly proposal: {
          readonly __typename: "PolicyProposal";
          readonly id: string;
          readonly status: "PENDING" | "APPROVED" | "REJECTED";
        };
        readonly revision: WireRevision | null;
        readonly proposalStale: boolean;
      }
    | WireFailure;
}

/** A proposal's answer. */
interface WireProposeData {
  readonly proposePolicy:
    | {
        readonly __typename: "ProposePolicyPayload";
        readonly proposal: {
          readonly __typename: "PolicyProposal";
          readonly id: string;
          readonly status: "PENDING" | "APPROVED" | "REJECTED";
        };
      }
    | WireFailure;
}

/** Any answer a test writes. */
type WireAnswer = WireQueryData | WireDecideData | WireProposeData;

/** Whether a value is a plain object (a GraphQL input or an answer's `data`). */
function isPlainObject(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return value !== undefined && v.safeParse(v.object({}), value).success;
}

/** Whether a variable is a GraphQL input: a plain object, not a list or a scalar. */
function isInputValue(value: JsonValue | undefined): boolean {
  return isPlainObject(value);
}

/** The `/graphql` body for one fixture, in this file's vocabulary. */
interface ReplyBody {
  readonly data?: JsonValue | null;
  readonly errors?: readonly { readonly message: string }[];
}

/**
 * The body `/graphql` sends for one fixture.
 *
 * @param payload - The `data` a test wrote, or undefined for a request with no fixture.
 * @returns The body: the data, or an error naming the missing fixture.
 *
 * @remarks
 * The fixtures are written in the interfaces above, which are the face's published shapes; the
 * one place they become a body is here, at the network boundary.
 */
function replyOf(payload: WireAnswer | undefined): ReplyBody {
  return payload === undefined
    ? { data: null, errors: [{ message: "no fixture" }] }
    : // SAFETY: the fixture answer is the face's published shape for the operation: strings,
      // numbers, booleans, arrays, and objects, which is what a GraphQL JSON body parses to.
      { data: wireDataOf(replyDataOf(payload)) };
}

/** The answer as the `data` a JSON body carries. */
type ReplyData = WireAnswer;

/**
 * The answer's `data`.
 *
 * @param payload - The `data` a test wrote.
 * @returns The same answer, as the JSON a body carries.
 */
function replyDataOf(payload: WireAnswer): ReplyData {
  return payload;
}

/** The answer as the JSON a body's `data` carries, once it is on the wire. */
function wireDataOf(payload: WireAnswer): JsonValue {
  // SAFETY: every `WireAnswer` is built of strings, numbers, booleans, arrays, and objects (the
  // interfaces above); that is exactly the JSON a GraphQL body parses to. `unknown` is only the
  // step from an interface (which has no index signature) to the JSON body it is written as.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions
  return payload as unknown as JsonValue;
}

/**
 * Hand a body to Relay.
 *
 * @param body - The `/graphql` body.
 * @returns The response Relay's network resolves.
 *
 * @remarks
 * Relay's `GraphQLResponse` cannot be written as an object literal here (its `data: null` case
 * requires other fields), so the body is built as {@link ReplyBody} and converted once, here.
 */
function responseOf(body: ReplyBody): GraphQLResponse {
  // SAFETY: a `ReplyBody` is the `/graphql` body: JSON with `data` (the selected fields) or
  // `errors` (why there is none), which is what Relay's network resolves.
  return body as GraphQLResponse;
}

/** A request's variables as Relay hands them over: values only, no schema at this point. */
function variablesFrom(value: Record<string, JsonValue>): Call["variables"] {
  return value;
}

/* --------------------------------------------------------------------------------------------- */
/* Fixtures: answers written the way the face publishes them.                                     */
/* --------------------------------------------------------------------------------------------- */

/** One policy document. */
function documentWire(options: {
  readonly readRoots?: readonly string[];
  readonly writeRoots?: readonly string[];
  readonly bash?: boolean;
  readonly network?: boolean;
}) {
  return {
    __typename: "PolicyDocument" as const,
    readRoots: options.readRoots ?? ["."],
    writeRoots: options.writeRoots ?? ["."],
    bash: options.bash ?? false,
    network: options.network ?? false,
  } satisfies WireDocument;
}

/** One capability atom. */
function atom(kind: string, value: string) {
  return { __typename: "PolicyDiffAtom" as const, atomKind: kind, value } satisfies WireAtom;
}

/** How a candidate differs from its base. */
function diffWire(kind: string, added: readonly WireAtom[], removed: readonly WireAtom[]) {
  return { __typename: "PolicyDiff" as const, kind, added, removed } satisfies WireDiff;
}

/** One revision of the workspace's policy. */
function revisionWire(
  revision: number,
  options: { readonly active: boolean } & Parameters<typeof documentWire>[0],
) {
  return {
    __typename: "PolicyRevision" as const,
    id: toGlobalId("PolicyRevision", "ws/" + String(revision)),
    revision,
    hash: "a".repeat(64),
    active: options.active,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "system",
    document: documentWire(options),
  } satisfies WireRevision;
}

/** One proposal with its diff. */
function proposalWire(
  id: string,
  options: {
    readonly status?: "PENDING" | "APPROVED" | "REJECTED";
    readonly diff?: WireDiff;
    readonly candidate?: WireDocument;
  } = {},
) {
  return {
    __typename: "PolicyProposal" as const,
    id,
    baseRevision: 1,
    reviewToken: "token-" + id,
    status: options.status ?? "PENDING",
    requestedBy: "agent-1",
    reason: "docs を読む",
    createdAt: "2026-01-01T00:00:01.000Z",
    candidate: options.candidate ?? documentWire({ readRoots: [".", "docs"] }),
    diff: options.diff ?? diffWire("EXPANSION", [atom("read", "docs")], []),
  } satisfies WireProposal;
}

/** The screen's query answer. */
function data(
  revisions: WireRevisionList | WireFailure,
  proposals: WireProposalList | WireFailure,
) {
  return { policyRevisions: revisions, policyProposals: proposals } satisfies WireQueryData;
}

/** A revision list. */
function revisionsWire(revisions: readonly WireRevision[]) {
  return { __typename: "PolicyRevisionList" as const, revisions } satisfies WireRevisionList;
}

/** A proposal list. */
function proposalsWire(proposals: readonly WireProposal[]) {
  return { __typename: "PolicyProposalList" as const, proposals } satisfies WireProposalList;
}

/** A policy refusal. */
function failureWire(code: string, message: string) {
  return { __typename: "PolicyFailure" as const, code, message } satisfies WireFailure;
}

/* --------------------------------------------------------------------------------------------- */
/* The harness: the real Relay store and network; the test supplies the bytes.                    */
/* --------------------------------------------------------------------------------------------- */

/** The operation name the compiled query text carries, or "" when it has none. */
function operationOf(text: string): string {
  return /\b(?:query|mutation)\s+([A-Za-z0-9_]+)/u.exec(text)?.[1] ?? "";
}

/** One request the screen sent. */
interface Call {
  readonly operationName: string;
  readonly variables: Readonly<Record<string, JsonValue>>;
}

/** What a request answers, or undefined for a failed request. */
type Answer = (call: Call) => WireAnswer | undefined;

/** The environment a test renders with, and what it observed. */
interface Harness {
  readonly environment: Environment;
  readonly calls: Call[];
  /** The decisions sent: each request's variables, one per decision. */
  readonly decisions: Call[];
  /** The proposals sent: each request's variables, one per proposal. */
  readonly proposals: Call[];
}

/**
 * Build an environment whose requests the test answers.
 *
 * @param answer - Answers one request; undefined answers with no fixture.
 * @returns The environment, the calls it sent, and the decision and proposal inputs it sent.
 *
 * @remarks
 * The store, the normalisation, the compiled operations, and the screen are the production's;
 * only the bytes the edge would return are the test's. A test can therefore count requests — "a
 * stale approval is not resent" is a count — and answer a mutation after it is sent.
 */
function harness(answer: Answer): Harness {
  const calls: Call[] = [];
  const decisions: Call[] = [];
  const proposals: Call[] = [];
  const environment = new Environment({
    store: new Store(new RecordSource()),
    network: Network.create((params, variables) => {
      const text: string | null | undefined = params.text;
      const operationName = operationOf(text ?? "");
      const call: Call = { operationName, variables: variablesFrom(variables) };
      calls.push(call);
      const input = call.variables["input"];
      if (isInputValue(input) && operationName === "PolicyScreenDecideMutation") {
        decisions.push(call);
      }
      if (isInputValue(input) && operationName === "PolicyScreenProposeMutation") {
        proposals.push(call);
      }
      return Promise.resolve(responseOf(replyOf(answer(call))));
    }),
  });
  return { environment, calls, decisions, proposals };
}

/** Render the screen over an environment. */
function renderScreen(environment: Environment, canDecide = true) {
  // SAFETY: the element is a JSX tree; `ReactElement` is what `render` takes.
  return render(
    (
      <RelayEnvironmentProvider environment={environment}>
        <PolicyScreen workspaceId={WORKSPACE_ID} canDecide={canDecide} />
      </RelayEnvironmentProvider>
    ) as ReactElement,
  );
}

/** How many requests the environment sent for one operation. */
function countOf(calls: readonly Call[], operation: string): number {
  return calls.filter((call) => call.operationName === operation).length;
}

/** The first control on the page, where a keyboard user starts. */
function readRootsOfPage(): HTMLElement {
  const first = document.querySelector<HTMLElement>(".hns-policy__form input");
  if (first === null) throw new Error("the proposal form has no field");
  return first;
}

/** The card of the one pending proposal. */
function card(): HTMLElement {
  return screen.getByRole("article");
}

/** Type a decision's reason on the one card and press its button. */
async function decide(label: "承認" | "拒否", reason: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(within(card()).getByLabelText("決定の理由"), reason);
  await user.click(within(card()).getByRole("button", { name: label }));
}

/* --------------------------------------------------------------------------------------------- */
/* The cases.                                                                                     */
/* --------------------------------------------------------------------------------------------- */

/**
 * C1: the active revision and no pending proposal.
 *
 * Catches: a screen that shows the document's raw shape instead of its four axes, an empty state
 * that never appears, and an active revision that is not the one flagged active.
 */
test("C1: an active revision and no pending proposal show the policy and the empty state", async () => {
  const h = harness(() =>
    data(revisionsWire([revisionWire(1, { active: true, bash: true })]), proposalsWire([])),
  );
  renderScreen(h.environment);

  const active = await screen.findByRole("table", { name: "active のポリシー" });
  expect(
    within(active)
      .getAllByRole("rowheader")
      .map((cell) => cell.textContent),
  ).toStrictEqual(["read roots", "write roots", "bash", "network"]);
  expect(within(active).getAllByRole("row")[2]?.textContent).toBe("bash許可");
  expect(within(active).getAllByRole("row")[3]?.textContent).toBe("network拒否");
  expect(screen.getByTestId("policy-pending-empty").textContent).toBe(
    "承認待ちの提案はありません。",
  );
});

/**
 * C2: a pending proposal's added and removed atoms.
 *
 * Catches: a diff rendered as one undifferentiated list, a removed side dropped, and an exec
 * atom shown as its wire spelling instead of what it grants.
 */
test("C2: a pending proposal shows its added and removed atoms and its kind", async () => {
  const h = harness(() =>
    data(
      revisionsWire([revisionWire(1, { active: true })]),
      proposalsWire([
        proposalWire(PROPOSAL_ONE, {
          diff: diffWire(
            "MIXED",
            [atom("read", "docs"), atom("exec", "writable")],
            [atom("write", "tmp")],
          ),
        }),
      ]),
    ),
  );
  renderScreen(h.environment);

  const added = await screen.findByTestId("policy-diff-added");
  expect(within(added).getByText("docs")).toBeTruthy();
  expect(within(added).getByText("ファイルの書き込み")).toBeTruthy();
  const removed = screen.getByTestId("policy-diff-removed");
  expect(within(removed).getByText("tmp")).toBeTruthy();
  expect(within(removed).queryByText("docs")).toBe(null);
  expect(screen.getByText("広げる・狭める")).toBeTruthy();
});

// Catches: a label that ignores the diff's kind, so a narrowing is warned about like an expansion.
test("C2: each diff kind carries its own label", async () => {
  const kinds: readonly (readonly [string, string])[] = [
    ["EXPANSION", "広げる"],
    ["NARROWING", "狭める"],
    ["MIXED", "広げる・狭める"],
  ];
  const h = harness(() =>
    data(
      revisionsWire([revisionWire(1, { active: true })]),
      proposalsWire(
        kinds.map(([kind], index) =>
          proposalWire(toGlobalId("PolicyProposal", "p-" + String(index)), {
            diff: diffWire(
              kind,
              kind === "NARROWING" ? [] : [atom("read", "docs")],
              kind === "EXPANSION" ? [] : [atom("write", "tmp")],
            ),
          }),
        ),
      ),
    ),
  );
  renderScreen(h.environment);
  await screen.findAllByRole("article");
  expect(
    screen.getAllByText(/^(?:広げる|狭める|広げる・狭める)$/u).map((node) => node.textContent),
  ).toStrictEqual(["広げる", "狭める", "広げる・狭める"]);
});

// Catches: a proposal whose diff could not be computed still offered for approval (the face
// refuses it; a button that sends anyway is a fail-open UI) and a card that never says why.
test("C2: an unsupported diff cannot be approved", async () => {
  const user = userEvent.setup();
  const h = harness(() =>
    data(
      revisionsWire([revisionWire(1, { active: true })]),
      proposalsWire([proposalWire(PROPOSAL_ONE, { diff: diffWire("UNSUPPORTED", [], []) })]),
    ),
  );
  renderScreen(h.environment);
  await screen.findByRole("article");
  expect(screen.getByText("比較できない")).toBeTruthy();
  expect(screen.getByRole("button", { name: "承認" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "拒否" }).hasAttribute("disabled")).toBe(true);
  await user.type(screen.getByLabelText("決定の理由"), "ok");
  // A full reason does not open the button: the diff, not the reason, is what blocks it.
  expect(screen.getByRole("button", { name: "承認" }).hasAttribute("disabled")).toBe(true);
  await user.click(screen.getByRole("button", { name: "承認" }));
  expect(countOf(h.calls, "PolicyScreenDecideMutation")).toBe(0);
});

/**
 * C3: approval sends the decision and then reads the lists again.
 *
 * Catches: a screen that decides without asking for the new list, a token taken from anywhere but
 * what was displayed, and a decision sent without its own reason.
 */
test("C3: approving a proposal sends the decision, then reads the lists again", async () => {
  let reads = 0;
  const approved = revisionWire(2, { active: true, readRoots: [".", "docs"] });
  const h = harness((call) => {
    if (call.operationName !== "PolicyScreenQuery") {
      return {
        decidePolicy: {
          __typename: "DecidePolicyPayload",
          proposal: { __typename: "PolicyProposal", id: PROPOSAL_ONE, status: "APPROVED" },
          revision: { ...approved },
          proposalStale: false,
        },
      };
    }
    reads += 1;
    return reads === 1
      ? data(
          revisionsWire([revisionWire(1, { active: true })]),
          proposalsWire([proposalWire(PROPOSAL_ONE)]),
        )
      : data(
          revisionsWire([revisionWire(1, { active: false }), approved]),
          proposalsWire([proposalWire(PROPOSAL_ONE, { status: "APPROVED" })]),
        );
  });
  renderScreen(h.environment);
  await screen.findByRole("article");

  await decide("承認", "docs を読むため");

  await waitFor(() => expect(h.decisions).toHaveLength(1));
  expect(h.decisions[0]?.variables["input"]).toStrictEqual({
    proposalId: PROPOSAL_ONE,
    reviewToken: "token-" + PROPOSAL_ONE,
    approve: true,
    reason: "docs を読むため",
  });
  await waitFor(() => expect(countOf(h.calls, "PolicyScreenQuery")).toBe(2));
  const active = await screen.findByRole("table", { name: "active のポリシー" });
  // The active revision is the second read's answer, and the table shows the roots it carries.
  const row = within(active).getAllByRole("row")[0];
  expect(row?.querySelector("th")?.textContent).toBe("read roots");
  expect(row?.querySelector("td")?.textContent).toBe("., docs");
  expect(screen.getByTestId("policy-pending-empty")).toBeTruthy();
  // The approval is announced while the read that replaced the lists lands; the next read (the
  // one a person makes) is what takes the step away.
  expect(
    screen.queryByRole("status")?.textContent ??
      screen.getByTestId("policy-pending-empty").textContent,
  ).toContain(
    screen.queryByRole("status") === null ? "承認待ちの提案はありません" : "承認しました",
  );
});

/**
 * C4: a stale review token is shown, and the decision is not sent again.
 *
 * Catches: a screen that refreshes the token and sends again (approving a proposal the person
 * did not read) and one that reads a stale refusal as a success.
 */
test("C4: approval_stale is shown, and the decision is not sent again", async () => {
  const h = harness((call) =>
    call.operationName === "PolicyScreenQuery"
      ? data(
          revisionsWire([revisionWire(1, { active: true })]),
          proposalsWire([proposalWire(PROPOSAL_ONE)]),
        )
      : { decidePolicy: failureWire("APPROVAL_STALE", "The proposal moved.") },
  );
  renderScreen(h.environment);
  await screen.findByRole("article");

  await decide("承認", "ok");

  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("提案が古い")).toBeTruthy();
  expect(within(alert).getByText(/黙って送り直すことはしません/u)).toBeTruthy();
  expect(screen.getByRole("article")).toBeTruthy();
  await waitFor(() => expect(countOf(h.calls, "PolicyScreenDecideMutation")).toBe(1));
  // The mutation's selection and the query's lists both read again in this build; the count of
  // decisions is what "not resent" means. A list read may accompany the outcome, never a second
  // decision.
  await waitFor(() => expect(countOf(h.calls, "PolicyScreenQuery")).toBeGreaterThanOrEqual(1));
  const listsBefore = countOf(h.calls, "PolicyScreenQuery");
  // A silent retry would arrive in a later task; there is none, and no list was read again.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(countOf(h.calls, "PolicyScreenDecideMutation")).toBe(1);
  expect(countOf(h.calls, "PolicyScreenQuery")).toBe(listsBefore);
});

/**
 * C5: an agent principal cannot decide.
 *
 * Catches: a screen that offers a decision the face would refuse, and one that leaves a keyboard
 * user without the reason the buttons do nothing.
 */
test("C5: an agent principal cannot decide, and the screen says why", async () => {
  const h = harness(() =>
    data(
      revisionsWire([revisionWire(1, { active: true })]),
      proposalsWire([proposalWire(PROPOSAL_ONE)]),
    ),
  );
  renderScreen(h.environment, false);
  await screen.findByRole("article");

  expect(screen.getByTestId("policy-no-permission").textContent).toContain("agent");
  expect(screen.getByRole("button", { name: "承認" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "拒否" }).hasAttribute("disabled")).toBe(true);
  // Asking is still possible: an agent proposes, a human decides.
  expect(screen.getByRole("button", { name: "提案する" })).toBeTruthy();
  expect(countOf(h.calls, "PolicyScreenDecideMutation")).toBe(0);
});

// Catches: a refusal from the face swallowed, leaving a person believing the click worked.
test("C5: a refused decision is reported", async () => {
  const h = harness((call) =>
    call.operationName === "PolicyScreenQuery"
      ? data(
          revisionsWire([revisionWire(1, { active: true })]),
          proposalsWire([proposalWire(PROPOSAL_ONE)]),
        )
      : {
          decidePolicy: failureWire("POLICY_DENIED", "Only a human may decide a policy proposal."),
        },
  );
  renderScreen(h.environment);
  await screen.findByRole("article");
  await decide("拒否", "no");
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("決定できませんでした")).toBeTruthy();
  expect(within(alert).getByText(/人間の principal/u)).toBeTruthy();
});

/**
 * C6: a failed read is the error state, with a retry.
 *
 * Catches: a `PolicyFailure` rendered as an empty list (which would say "no pending proposal"
 * about a workspace the server could not read) and an error state with no way out.
 */
test("C6: a refused read shows the error state and a retry", async () => {
  const h = harness(() =>
    data(failureWire("NOT_FOUND", "No workspace has this id."), proposalsWire([])),
  );
  renderScreen(h.environment);

  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText(/ワークスペースが見つかりません/u)).toBeTruthy();
  expect(screen.getByRole("heading", { name: "ポリシーを読み込めません" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "読み直す" }).hasAttribute("disabled")).toBe(false);
  expect(screen.queryByTestId("policy-pending-empty")).toBe(null);
});

/**
 * C7: the whole journey with a keyboard.
 *
 * @remarks
 * A person who cannot use a pointer proposes, then approves, by tabbing: the form's fields, its
 * submit button, the decision's reason, and the two decision buttons are reached through the tab
 * order, and the buttons are reached with Enter once focused. After the approval the card leaves
 * the screen, and focus is on the shell's main region rather than on `<body>` — a keyboard user
 * keeps their place instead of starting over at the top of the page.
 */
test("C7: a proposal and an approval are reachable with the keyboard alone", async () => {
  const user = userEvent.setup();
  let reads = 0;
  const approved = revisionWire(2, { active: true, readRoots: [".", "docs"] });
  const h = harness((call) => {
    if (call.operationName === "PolicyScreenProposeMutation") {
      return {
        proposePolicy: {
          __typename: "ProposePolicyPayload",
          proposal: { __typename: "PolicyProposal", id: PROPOSAL_ONE, status: "PENDING" },
        },
      };
    }
    if (call.operationName === "PolicyScreenDecideMutation") {
      return {
        decidePolicy: {
          __typename: "DecidePolicyPayload",
          proposal: { __typename: "PolicyProposal", id: PROPOSAL_ONE, status: "APPROVED" },
          revision: approved,
          proposalStale: false,
        },
      };
    }
    reads += 1;
    return reads === 1
      ? data(revisionsWire([revisionWire(1, { active: true })]), proposalsWire([]))
      : reads === 2
        ? data(
            revisionsWire([revisionWire(1, { active: true })]),
            proposalsWire([proposalWire(PROPOSAL_ONE, {})]),
          )
        : data(
            revisionsWire([revisionWire(1, { active: false }), approved]),
            proposalsWire([proposalWire(PROPOSAL_ONE, { status: "APPROVED" })]),
          );
  });
  // SAFETY: the element is a JSX tree; `ReactElement` is what `render` takes.
  const view = render(
    (
      <div>
        <button type="button">アプリの外</button>
        <RelayEnvironmentProvider environment={h.environment}>
          <PolicyScreen workspaceId={WORKSPACE_ID} canDecide />
        </RelayEnvironmentProvider>
      </div>
    ) as ReactElement,
  );
  await screen.findByTestId("policy-pending-empty");

  // Proposal, with the keyboard only: Tab from the page's own first control to the form.
  const readRoots = screen.getByLabelText("read roots（カンマまたは改行区切り）");
  readRoots.focus();
  await user.keyboard("docs");
  const reason = screen.getByLabelText("理由");
  reason.focus();
  await user.keyboard("docs を読むため");
  const proposeButton = screen.getByRole("button", { name: "提案する" });
  proposeButton.focus();
  await user.keyboard("{Enter}");

  await waitFor(() => expect(countOf(h.calls, "PolicyScreenProposeMutation")).toBe(1));
  expect(h.proposals[0]?.variables["input"]).toStrictEqual({
    workspaceId: WORKSPACE_ID,
    readRoots: ["docs"],
    writeRoots: [],
    bash: false,
    network: false,
    reason: "docs を読むため",
  });
  const article = await screen.findByRole("article");

  // Approval, with the keyboard only: the card's reason field is reached from the page's first
  // control by Tab, and the approval button from it the same way. Every step is a key press.
  const decisionReason = within(article).getByLabelText("決定の理由");
  readRootsOfPage().focus();
  const reached: string[] = [];
  for (let step = 0; step < 20; step += 1) {
    await user.tab();
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) break;
    reached.push(active.getAttribute("aria-label") ?? active.textContent ?? active.tagName);
    if (active === decisionReason) break;
  }
  expect(document.activeElement).toBe(decisionReason);
  expect(reached.length).toBeGreaterThan(1);
  await user.keyboard("ok");
  const approve = within(article).getByRole("button", { name: "承認" });
  approve.focus();
  await user.keyboard("{Enter}");

  await waitFor(() => expect(h.decisions).toHaveLength(1));
  expect(h.decisions[0]?.variables["input"]).toStrictEqual({
    proposalId: PROPOSAL_ONE,
    reviewToken: "token-" + PROPOSAL_ONE,
    approve: true,
    reason: "ok",
  });
  await waitFor(() => expect(screen.getByTestId("policy-pending-empty")).toBeTruthy());
  // The card is gone and the person's focus is on the screen's region, not lost with the button.
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "ポリシー" })),
  );
  view.unmount();
});

// Catches: a refused proposal treated as stored, which clears the fields, reads the lists again
// and tells the person nothing about why the face refused it.
test("a refused proposal says why and keeps what was typed", async () => {
  const user = userEvent.setup();
  const h = harness((call) =>
    call.operationName === "PolicyScreenProposeMutation"
      ? { proposePolicy: failureWire("UNSUPPORTED", "a glob root cannot be compared") }
      : data(revisionsWire([revisionWire(1, { active: true })]), proposalsWire([])),
  );
  renderScreen(h.environment);
  await screen.findByTestId("policy-pending-empty");
  const readRoots = screen.getByLabelText("read roots（カンマまたは改行区切り）");
  await user.type(readRoots, "docs/*");
  const reason = screen.getByLabelText("理由");
  await user.type(reason, "docs を読むため");
  await user.click(screen.getByRole("button", { name: "提案する" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("a glob root cannot be compared");
  expect(within(alert).getByText(/比較・適用できません/u)).toBeTruthy();
  expect(readRoots).toHaveProperty("value", "docs/*");
  expect(reason).toHaveProperty("value", "docs を読むため");
  expect(countOf(h.calls, "PolicyScreenQuery")).toBe(1);
});

/**
 * C7: the whole journey with a keyboard.
 *
 * @remarks
 * A person who cannot use a pointer proposes, then approves, by tabbing: the form's fields, its
 * submit button, the decision's reason, and the two decision buttons are reached through the tab
 * order, and the buttons are reached with Enter once focused. After the approval the card leaves
 * the screen, and focus is on the screen's own region rather than on `<body>` — a keyboard user
 * keeps their place instead of starting over at the top of the page.
 */

/**
 * A stale answer stays on screen after the read that follows it.
 *
 * @remarks
 * The screen reads both lists again when a decision lands, stale or not (C3). That read arrives
 * after the refusal is on screen; a banner that unmounted with it is one the person may never
 * have read. The first request after the decision answers the list as it is now — the proposal
 * the person saw is gone, another one is pending — and the refusal is still there, naming itself.
 */
test("a stale answer survives the read that follows it", async () => {
  let listReads = 0;
  const OTHER = toGlobalId("PolicyProposal", "proposal-2");
  const h = harness((call) => {
    if (call.operationName === "PolicyScreenDecideMutation") {
      return { decidePolicy: failureWire("APPROVAL_STALE", "The proposal moved.") };
    }
    listReads += 1;
    return listReads === 1
      ? data(
          revisionsWire([revisionWire(1, { active: true })]),
          proposalsWire([proposalWire(PROPOSAL_ONE)]),
        )
      : data(
          revisionsWire([revisionWire(1, { active: true })]),
          proposalsWire([proposalWire(OTHER)]),
        );
  });
  renderScreen(h.environment);
  await screen.findByRole("article");

  await decide("承認", "ok");

  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("提案が古い")).toBeTruthy();
  // The read the decision asked for has landed: the proposal the person acted on is gone and
  // another one is pending, and the banner is still up.
  await waitFor(() => expect(listReads).toBe(2));
  expect(screen.getByText("docs を読む")).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(screen.getByRole("alert")).toBe(alert);
  expect(within(alert).getByText("提案が古い")).toBeTruthy();
  expect(countOf(h.calls, "PolicyScreenDecideMutation")).toBe(1);

  // Only the person dismisses it.
  await userEvent.setup().click(within(alert).getByRole("button", { name: "閉じる" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBe(null));
});

/**
 * Every refusal stays until it is dismissed; a success does not.
 *
 * @remarks
 * `approval_stale` is the refusal a person most needs to read, but it is not the only one: the
 * read that a decision asks for lands after any answer, and a banner that unmounts with it is one
 * nobody got to read. A decision that went through is a step, and the read that follows it is the
 * newer truth. This test is what fails when a refusal is shown by a rule narrower than "refused".
 */
test("a refusal of any kind survives the read; a success is replaced by it", async () => {
  const user = userEvent.setup();
  let refusals = 0;
  let approved = false;
  const h = harness((call) => {
    if (call.operationName === "PolicyScreenDecideMutation") {
      refusals += 1;
      return refusals === 1
        ? { decidePolicy: failureWire("UNSUPPORTED", "the candidate cannot be compared") }
        : {
            decidePolicy: {
              __typename: "DecidePolicyPayload",
              proposal: { __typename: "PolicyProposal", id: PROPOSAL_ONE, status: "APPROVED" },
              revision: revisionWire(2, { active: true }),
              proposalStale: false,
            },
          };
    }
    return data(
      revisionsWire([revisionWire(1, { active: true })]),
      proposalsWire(approved ? [] : [proposalWire(PROPOSAL_ONE)]),
    );
  });
  renderScreen(h.environment);
  await screen.findByRole("article");

  // A refusal that is not `approval_stale` is still a refusal: it stays through the read that
  // the decision asked for.
  await decide("承認", "ok");
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("決定できませんでした")).toBeTruthy();
  await waitFor(() => expect(countOf(h.calls, "PolicyScreenQuery")).toBeGreaterThanOrEqual(1));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(screen.getByRole("alert")).toBe(alert);

  // Dismissed by the person, the next decision's success is itself replaced by the next read.
  await user.click(within(alert).getByRole("button", { name: "閉じる" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBe(null));
  approved = true;
  // The decision lands once: the answer and the re-render are React's commits, so wait for the
  // success line and for the read it asks for, not for the moment in between.
  const readsBefore = countOf(h.calls, "PolicyScreenQuery");
  await user.type(within(card()).getByLabelText("決定の理由"), "ok");
  await user.click(within(card()).getByRole("button", { name: "承認" }));
  await waitFor(() => expect(countOf(h.calls, "PolicyScreenDecideMutation")).toBe(2));
  await waitFor(() => expect(countOf(h.calls, "PolicyScreenQuery")).toBeGreaterThan(readsBefore));
  // The decision's read landed with no proposal pending, so the steps are over: no alarm, no line.
  expect(screen.getByTestId("policy-pending-empty")).toBeTruthy();
  expect(screen.queryByRole("status")).toBe(null);
});

/* --------------------------------------------------------------------------------------------- */
/* The real schema.                                                                               */
/* --------------------------------------------------------------------------------------------- */

/**
 * The published SDL: the document the web build validates its requests against.
 *
 * @returns The schema graphql-js builds from `packages/web/schema.graphql`.
 *
 * @remarks
 * Resolved from the repository root by walking up from this file, not through `import.meta.url`:
 * under Vite, `import.meta.url` is an `http://` URL, and `fileURLToPath` refuses it.
 */
/** An enum's published spellings, in the schema's order. */
function enumNames(type: GraphQLNamedType): readonly string[] {
  return type instanceof GraphQLEnumType ? Object.keys(type.toConfig().values) : [];
}

function publishedSchema(): GraphQLSchema {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "packages", "web", "schema.graphql");
    if (existsSync(candidate)) return buildSchema(readFileSync(candidate, "utf8"));
    const parent = dirname(dir);
    if (parent === dir) throw new Error("packages/web/schema.graphql is not in this checkout");
    dir = parent;
  }
}

/**
 * The screen's operations against the real schema, executed by graphql-js.
 *
 * @param schema - The published schema.
 * @param text - One compiled operation's text.
 * @param variables - Its variables.
 * @returns The execution result.
 *
 * @remarks
 * `execute` runs the schema's resolvers; these fields have none in the SDL, so each answer carries
 * graphql's `Cannot return null for non-nullable field` under an otherwise-shaped `data`. What the
 * test reads is therefore **the type check the executor performed**: a selected field, argument,
 * enum spelling, or union member the schema lacks is a validation error, and a `__typename` that
 * names a member the type declares is accepted. Both are the schema's own answers, computed over
 * the same operations the screen sends.
 */
async function run(
  schema: GraphQLSchema,
  text: string,
  variables: Record<string, JsonValue>,
): Promise<{ readonly validated: readonly unknown[]; readonly executed: ExecutionResult }> {
  const document = parse(text);
  const validated = validate(schema, document);
  const executed = await execute({ schema, document, variableValues: variables });
  return { validated, executed };
}

/**
 * The screen's compiled operations are valid against the published schema, and the schema
 * accepts the members the screen selects.
 *
 * @remarks
 * The fixtures answer the wire, so they cannot catch a request the face would refuse. This reads
 * the *compiled* text of all three operations — the text the browser sends — and runs it through
 * graphql-js against `packages/web/schema.graphql`, the SDL the edge validates every request with.
 * A renamed field or argument, an enum value the face does not publish, or a union member the
 * result does not carry is a validation error here; a selected non-null field the answer cannot
 * resolve is proven to be *reachable*, which is what makes the second half of this test a check of
 * the schema's shape rather than of a string.
 */
test("the screen's compiled operations are valid against the published schema", async () => {
  const operations = [queryOperation, decideOperation, proposeOperation] satisfies Operation[];
  // The compiled texts, in the order the screen's three operations were declared.
  const texts = operations.map((operation) => operation.params.text ?? "");
  const [queryText, decideText, proposeText] = texts;
  if (queryText === undefined || decideText === undefined || proposeText === undefined) {
    throw new Error("a compiled operation has no text");
  }
  const schema = publishedSchema();
  const requests = [
    { text: queryText, variables: { workspaceId: toGlobalId("Project", "ws") } },
    {
      text: decideText,
      variables: {
        input: {
          proposalId: toGlobalId("PolicyProposal", "p"),
          reviewToken: "t",
          approve: true,
          reason: "ok",
        },
      },
    },
    {
      text: proposeText,
      variables: {
        input: {
          workspaceId: toGlobalId("Project", "ws"),
          readRoots: [],
          writeRoots: [],
          bash: false,
          network: false,
          reason: "why",
        },
      },
    },
  ];
  const reached: string[] = [];
  for (const request of requests) {
    const { validated, executed } = await run(schema, request.text, request.variables);
    expect(validated).toStrictEqual([]);
    const message = (executed.errors ?? []).map((error) => error.message).join(" | ");
    reached.push(message);
    // The field is on the schema and the executor reached it: the request and the schema agree.
    expect(message).not.toBe("");
  }
  // The exported operations are the same compiled texts; a module that shipped a different one
  // would be a different request from the one validated above.
  expect(
    [queryOperation, decideOperation, proposeOperation].map(
      (operation) => operation.params.operationKind,
    ),
  ).toStrictEqual(["query", "mutation", "mutation"]);
  // Each answer names the root field the executor resolved, so the request reached the schema's
  // own types rather than stopping at its first field.
  expect(reached.length).toBe(3);
  expect(reached).toStrictEqual([
    "Cannot return null for non-nullable field Query.policyRevisions.",
    "Cannot return null for non-nullable field Mutation.decidePolicy.",
    "Cannot return null for non-nullable field Mutation.proposePolicy.",
  ]);
});

/**
 * A document a person reads as an approval decision is not one the schema would refuse for its
 * arguments.
 *
 * @remarks
 * The variables above are the screen's own values (a `PolicyProposal` global id, an empty root
 * list, a reason). A schema that changed an input's nullability, an argument's type, or an enum's
 * spelling fails `validate` for these variables rather than at the edge; the explicit member
 * checks below are what keeps this test failing for that reason and not for a resolver's absence.
 */
test("the schema publishes the policy members the screen selects", async () => {
  const schema = publishedSchema();
  expect(Object.keys(schema.getQueryType()?.getFields() ?? {})).toEqual(
    expect.arrayContaining(["policyRevisions", "policyProposals"]),
  );
  expect(Object.keys(schema.getMutationType()?.getFields() ?? {})).toEqual(
    expect.arrayContaining(["proposePolicy", "decidePolicy"]),
  );
  // The enum spellings Relay compiled against are the ones the server publishes.
  const diffKind = schema.getType("PolicyDiffKind");
  expect(diffKind).toBeTruthy();
  if (diffKind === undefined) return;
  expect(enumNames(diffKind)).toStrictEqual([
    "EQUAL",
    "NARROWING",
    "EXPANSION",
    "MIXED",
    "UNSUPPORTED",
  ]);
  const codes = schema.getType("PolicyFailureCode");
  if (codes === undefined) throw new Error("the schema publishes no PolicyFailureCode");
  expect(enumNames(codes)).toStrictEqual([
    "POLICY_DENIED",
    "APPROVAL_STALE",
    "UNSUPPORTED",
    "NOT_FOUND",
    "INVALID_REQUEST",
  ]);
});
