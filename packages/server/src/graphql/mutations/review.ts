import * as v from "valibot";
import {
  TRAIL_DECISION_ACTIONS,
  TRAIL_FINDING_SEVERITIES,
  TRAIL_FINDING_SOURCES,
  trailReviseInput,
  type TrailDecisionAction,
  type TrailFinding,
} from "@hns/core";
import { fromGlobalId } from "@hns/core/graphql";
import {
  GraphQLEnumType,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  GraphQLUnionType,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigMap,
} from "graphql";
import type {
  TrailDecisionCreateInput,
  TrailDecisionValue,
  TrailFindingCreateInput,
  TrailFindingValue,
  TrailWriteRefusal,
} from "@hns/store";
import type { GraphQLContext } from "../context.ts";
import { QueryReadError } from "../failures.ts";
import {
  reviewDiffView,
  trailDecisionView,
  trailFindingView,
  type ReviewDiffView,
  type TrailDecisionView,
  type TrailFindingView,
} from "../views.ts";
import { enumValues } from "./enums.ts";
import { MutationFailureType, mutationFailure, type MutationFailureView } from "./failure.ts";
import type { MutationModule } from "./index.ts";

/**
 * The review face's writes (0232): the decision, the finding, and the three hunk actions.
 *
 * @remarks
 * **"Implemented" and "called" are different questions here**, and the module keeps them apart:
 *
 * - `decideTrail` and `raiseFinding` are wired end to end: a resolver, a `context.writes` port,
 *   the store's `addDecision` / `addFinding`, and the Trail's `decisions` / `findings` lists
 *   the screen reads back.
 * - `keepHunk`, `undoHunk`, and `applyHunk` are wired to `context.review.hunk`, whose
 *   production implementation (`review/write.ts`) does the versioned write **when it is given a
 *   writable workspace root**. The Worker has none, so the production port answers
 *   `unavailable`; the rules are proven against the real `applyVersionedWrite` in a test.
 *   Turning it on is a machine-side Workspace reach, not a new mutation.
 *
 * **An approval is about a head commit.** `decideTrail` passes the head the caller read (the
 * Change's `headCommit`); the store refuses one the Trail's Changes do not name, and
 * `Trail.gates` answers `fail` for the human gate the moment the head moves. So C2 is held by
 * two layers that do not have to agree in wording, only in effect.
 *
 * **A revise carries its points forward.** `decideTrail` with `action: requestChanges` answers
 * the `nextRunInput`: the Trail's open findings as the text the next Run starts from
 * (`core`'s `trailReviseInput`). That is C4: the review's points are what the next Run is given.
 */

/** The successful member of `decideTrail`: the Decision, and what a next Run is given. */
interface DecideTrailPayloadView {
  readonly __typename: "DecideTrailPayload";
  readonly decision: TrailDecisionView;
  /** The open findings as the next Run's input; empty when nothing is open. */
  readonly nextRunInput: string;
}

/** The successful member of `raiseFinding`: the Finding. */
interface RaiseFindingPayloadView {
  readonly __typename: "RaiseFindingPayload";
  readonly finding: TrailFindingView;
}

/** The successful member of a hunk action: the diff re-read after the write. */
interface ReviewHunkPayloadView {
  readonly __typename: "ReviewHunkPayload";
  readonly diff: ReviewDiffView;
}

/** The result unions. */
export type DecideTrailResult = DecideTrailPayloadView | MutationFailureView;
export type RaiseFindingResult = RaiseFindingPayloadView | MutationFailureView;
export type ReviewHunkResult = ReviewHunkPayloadView | MutationFailureView;

/**
 * A read-only contract with writable fields, for an object one field at a time builds.
 *
 * @remarks
 * `exactOptionalPropertyTypes` means a present key cannot hold `undefined`, so the optional
 * fields are assigned only when the client gave them (absent is "not named"); a literal typed
 * `Readonly` cannot be written that way. This is the one narrowing, not a widening: the fields
 * and their types are the store's own.
 */
type Mutable<TValue> = { -readonly [K in keyof TValue]: TValue[K] };

/** The bound on a decision's note and a finding's summary: prose, but not a request body. */
const MAX_TEXT_LENGTH = 10_000;

/** `TrailDecisionActionInput`: the model's closed action vocabulary. */
const DecisionActionInput = new GraphQLEnumType({
  name: "TrailDecisionActionInput",
  values: enumValues(TRAIL_DECISION_ACTIONS),
});

/** `TrailFindingSeverityInput`: the model's closed severity vocabulary. */
const FindingSeverityInput = new GraphQLEnumType({
  name: "TrailFindingSeverityInput",
  values: enumValues(TRAIL_FINDING_SEVERITIES),
});

/** `TrailFindingSourceInput`: who raised the point. */
const FindingSourceInput = new GraphQLEnumType({
  name: "TrailFindingSourceInput",
  values: enumValues(TRAIL_FINDING_SOURCES),
});

/** The arguments `decideTrail` receives. */
interface DecideTrailArguments {
  readonly input: {
    readonly trailId: string;
    readonly action: string;
    readonly note?: string | null | undefined;
    readonly changeId?: string | null | undefined;
    readonly headCommit?: string | null | undefined;
    readonly resolveFindingIds?: readonly string[] | null | undefined;
  };
}

/** The arguments `raiseFinding` receives. */
interface RaiseFindingArguments {
  readonly input: {
    readonly trailId: string;
    readonly severity: string;
    readonly source: string;
    readonly summary: string;
    readonly file?: string | null | undefined;
    readonly hunk?: string | null | undefined;
    readonly changeId?: string | null | undefined;
  };
}

/** The arguments a hunk action receives: the Change, the path, the hunk, and the version. */
interface ReviewHunkArguments {
  readonly input: {
    readonly changeId: string;
    readonly path: string;
    readonly headStart: number;
    readonly expectedVersion: string;
  };
}

/**
 * The `decideTrail` input.
 *
 * @remarks
 * `headCommit` is the commit the decision is about, and an `approve` without one is refused: an
 * approval that does not name what it approved could never be invalidated by a later head (C2).
 * `resolveFindingIds` is the revise path's other half: the points a person says the next Run has
 * addressed become `resolved` with the decision.
 */
const DecideTrailInput = new GraphQLInputObjectType({
  name: "DecideTrailInput",
  fields: {
    trailId: { type: new GraphQLNonNull(GraphQLID) },
    action: { type: new GraphQLNonNull(DecisionActionInput) },
    note: { type: GraphQLString },
    changeId: { type: GraphQLID },
    headCommit: { type: GraphQLString },
    resolveFindingIds: { type: new GraphQLList(GraphQLID) },
  },
});

/** The `raiseFinding` input: a point an agent, a test, or a person raised. */
const RaiseFindingInput = new GraphQLInputObjectType({
  name: "RaiseFindingInput",
  fields: {
    trailId: { type: new GraphQLNonNull(GraphQLID) },
    severity: { type: new GraphQLNonNull(FindingSeverityInput) },
    source: { type: new GraphQLNonNull(FindingSourceInput) },
    summary: { type: new GraphQLNonNull(GraphQLString) },
    file: { type: GraphQLString },
    hunk: { type: GraphQLString },
    changeId: { type: GraphQLID },
  },
});

/** A hunk action's input: which Change, which path, which hunk, and the version the caller saw. */
const ReviewHunkInput = new GraphQLInputObjectType({
  name: "ReviewHunkInput",
  fields: {
    changeId: { type: new GraphQLNonNull(GraphQLID) },
    path: { type: new GraphQLNonNull(GraphQLString) },
    headStart: { type: new GraphQLNonNull(GraphQLInt) },
    expectedVersion: { type: new GraphQLNonNull(GraphQLString) },
  },
});
/**
 * Decode a global id of one type.
 *
 * @internal
 * @param value - The id a client sent.
 * @param type - The type it must be.
 * @returns The stored id.
 * @throws QueryReadError with `invalid_request` when the id is another type's or malformed.
 */
function idOf(value: string, type: string): string {
  const decoded = fromGlobalId(value);
  if (!decoded.ok || decoded.value.type !== type) {
    throw new QueryReadError("invalid_request", "The id must be a " + type + " global id.");
  }
  return decoded.value.id;
}

/** Check a decision's action against the model's vocabulary. */
function actionOf(value: string): TrailDecisionAction {
  const found = TRAIL_DECISION_ACTIONS.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new QueryReadError("invalid_request", "The action is not one this build knows.");
  }
  return found;
}

/** Check a finding's severity and source against the model's vocabularies. */
function severityOf(value: string): TrailFinding["severity"] {
  const found = TRAIL_FINDING_SEVERITIES.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new QueryReadError("invalid_request", "The severity is not one this build knows.");
  }
  return found;
}

/** Check a finding's source against the model's vocabulary. */
function sourceOf(value: string): TrailFinding["source"] {
  const found = TRAIL_FINDING_SOURCES.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new QueryReadError("invalid_request", "The source is not one this build knows.");
  }
  return found;
}

/** Check one free-text field against the bound. */
function textOf(value: string | null | undefined): string {
  const text = value ?? "";
  if (text.length > MAX_TEXT_LENGTH) {
    throw new QueryReadError(
      "invalid_request",
      "text must be at most " + String(MAX_TEXT_LENGTH) + " characters.",
    );
  }
  return text;
}

/**
 * Map a store refusal to the failure a review write answers with.
 *
 * @internal
 * @remarks
 * `invalid_head` is the caller's mistake here (they approved a commit the Trail does not have), so
 * it is `invalid_request`; `invalid_change` and `invalid_transition` cannot come from these
 * writes and are defects.
 */
function refusalOf(refusal: TrailWriteRefusal): MutationFailureView {
  switch (refusal.kind) {
    case "not_found":
      return mutationFailure("not_found", "No trail, change, or finding has this id.");
    case "corrupt_row":
      return mutationFailure("unavailable", "The stored trail could not be read.");
    case "invalid_head":
      return mutationFailure(
        "invalid_request",
        "An approval must name a head commit one of the trail's changes has.",
      );
    case "invalid_transition":
    case "invalid_change":
      throw new Error("a review write cannot refuse as " + refusal.kind);
    default:
      return assertNever(refusal);
  }
}

/** Fail on a refusal this module did not expect. */
function assertNever(value: never): never {
  throw new Error("unexpected review refusal: " + JSON.stringify(value));
}

/**
 * Turn a check's exception into the failure member it stands for.
 *
 * @internal
 * @param error - What a check threw; parsed here into the two failure classes the resolver answers.
 * @returns The failure member.
 * @throws The error itself when it is neither a `QueryReadError` nor a `ValiError`.
 */
/* oxlint-disable anti-slop/no-unknown-parameters --
   A catch parameter is unknown by the language (useUnknownInCatchVariables); this is the parse.
*/
function failureOf(error: unknown): MutationFailureView {
  /* oxlint-enable anti-slop/no-unknown-parameters */
  if (error instanceof QueryReadError) return mutationFailure(error.code, error.message);
  if (error instanceof v.ValiError) return mutationFailure("invalid_request", error.message);
  throw error;
}

/** The diff a hunk action answers with, or the failure the write refused with. */
function hunkFailureOf(code: string, message: string): MutationFailureView {
  switch (code) {
    case "conflict":
      return mutationFailure("conflict", message);
    case "invalid_request":
      return mutationFailure("invalid_request", message);
    case "not_found":
      return mutationFailure("not_found", message);
    default:
      return mutationFailure("unavailable", message);
  }
}

/**
 * The review face's mutation fields (0232).
 *
 * @returns The module that adds `decideTrail`, `raiseFinding`, `keepHunk`, `undoHunk`, and
 * `applyHunk` to the Mutation root.
 *
 * @remarks
 * The actor is the session's subject, never an argument: a decision is recorded as the person (or
 * agent) who made it, and this build's face has one subject per session.
 */
export function reviewModule(): MutationModule {
  return {
    name: "review",
    fields: (
      objects: ReadonlyMap<string, GraphQLObjectType>,
      overrides: ReadonlyMap<string, GraphQLObjectType>,
    ): GraphQLFieldConfigMap<undefined, GraphQLContext> => {
      const diffType = overrides.get("ReviewDiff");
      if (diffType === undefined) throw new Error("the schema has no ReviewDiff type");
      const decidePayload = new GraphQLObjectType({
        name: "DecideTrailPayload",
        fields: {
          decision: {
            type: new GraphQLNonNull(objectTypeOf(objects, "TrailDecision")),
          },
          nextRunInput: { type: new GraphQLNonNull(GraphQLString) },
        },
      });
      const decideResult = new GraphQLUnionType({
        name: "DecideTrailResult",
        types: [decidePayload, MutationFailureType],
        resolveType: (value: DecideTrailResult): string => value.__typename,
      });
      const findingPayload = new GraphQLObjectType({
        name: "RaiseFindingPayload",
        fields: { finding: { type: new GraphQLNonNull(objectTypeOf(objects, "TrailFinding")) } },
      });
      const findingResult = new GraphQLUnionType({
        name: "RaiseFindingResult",
        types: [findingPayload, MutationFailureType],
        resolveType: (value: RaiseFindingResult): string => value.__typename,
      });
      const hunkPayload = new GraphQLObjectType({
        name: "ReviewHunkPayload",
        fields: { diff: { type: new GraphQLNonNull(diffType) } },
      });
      const hunkResult = new GraphQLUnionType({
        name: "ReviewHunkResult",
        types: [hunkPayload, MutationFailureType],
        resolveType: (value: ReviewHunkResult): string => value.__typename,
      });
      const hunkField = (
        action: "keep" | "undo" | "apply",
      ): GraphQLFieldConfig<undefined, GraphQLContext> => ({
        type: new GraphQLNonNull(hunkResult),
        args: { input: { type: new GraphQLNonNull(ReviewHunkInput) } },
        resolve: async (
          _source: undefined,
          args: ReviewHunkArguments,
          context: GraphQLContext,
        ): Promise<ReviewHunkResult> => {
          if (context.session.subject.length === 0) {
            return mutationFailure("forbidden", "A session is required to change a file.");
          }
          let changeId: string;
          let path: string;
          let expectedVersion: string;
          try {
            changeId = idOf(args.input.changeId, "TrailChange");
            path = nonEmptyPath(args.input.path);
            expectedVersion = nonEmptyPath(args.input.expectedVersion);
          } catch (error) {
            return failureOf(error);
          }
          if (!context.budget.spend(1)) {
            return mutationFailure("limit_exceeded", "This request writes more rows than it may.");
          }
          // The Change the caller names is the base..head pair the hunk belongs to: read it here
          // so a hunk can never be written against a pair the caller invented.
          const pair = await pairOf(context, changeId);
          if (pair === undefined) return mutationFailure("not_found", "No change has this id.");
          const written = await context.review.hunk(action, {
            changeId,
            base: pair.base,
            head: pair.head,
            path,
            headStart: args.input.headStart,
            expectedVersion,
            actor: context.session.subject,
          });
          if (!written.ok) return hunkFailureOf(written.code, written.message);
          return { __typename: "ReviewHunkPayload", diff: reviewDiffView(written.diff) };
        },
      });
      return {
        decideTrail: {
          type: new GraphQLNonNull(decideResult),
          args: { input: { type: new GraphQLNonNull(DecideTrailInput) } },
          resolve: async (
            _source: undefined,
            args: DecideTrailArguments,
            context: GraphQLContext,
          ): Promise<DecideTrailResult> => {
            if (context.session.subject.length === 0) {
              return mutationFailure("forbidden", "A session is required to decide a trail.");
            }
            let trailId: string;
            let action: TrailDecisionAction;
            let note: string;
            let changeId: string | undefined;
            let headCommit: string | undefined;
            let resolveFindingIds: readonly string[] | undefined;
            try {
              trailId = idOf(args.input.trailId, "Trail");
              action = actionOf(args.input.action);
              note = textOf(args.input.note);
              changeId =
                args.input.changeId === null || args.input.changeId === undefined
                  ? undefined
                  : idOf(args.input.changeId, "TrailChange");
              headCommit =
                args.input.headCommit === null || args.input.headCommit === undefined
                  ? undefined
                  : args.input.headCommit;
              resolveFindingIds =
                args.input.resolveFindingIds === null || args.input.resolveFindingIds === undefined
                  ? undefined
                  : args.input.resolveFindingIds.map((id) => idOf(id, "TrailFinding"));
            } catch (error) {
              return failureOf(error);
            }
            if (action === "approve" && headCommit === undefined) {
              return mutationFailure(
                "invalid_request",
                "An approval must name the head commit it approves.",
              );
            }
            if (!context.budget.spend(1)) {
              return mutationFailure(
                "limit_exceeded",
                "This request writes more rows than it may.",
              );
            }
            // `exactOptionalPropertyTypes`: a present key cannot hold undefined, so each optional
            // field is added only when the client gave it (absent means "no change named").
            const decision: Mutable<TrailDecisionCreateInput> = {
              action,
              actor: context.session.subject,
              note,
            };
            if (changeId !== undefined) decision.changeId = changeId;
            if (headCommit !== undefined) decision.headCommit = headCommit;
            if (resolveFindingIds !== undefined) decision.resolveFindingIds = resolveFindingIds;
            let decided: TrailDecisionValue | TrailWriteRefusal;
            try {
              decided = await context.writes.addTrailDecision(trailId, decision);
            } catch (error) {
              return failureOf(error);
            }
            if (decided.refused) return refusalOf(decided);
            // C4: the points a revise leaves open are what the next Run is given. Read after the
            // decision is stored, so the findings just resolved are not in the input twice.
            const head = await context.reads.trailHead(trailId);
            const findings = await rowsOf(await context.reads.trailFindings(trailId), context);
            return {
              __typename: "DecideTrailPayload",
              decision: trailDecisionView(decided),
              nextRunInput: trailReviseInput(findings, head?.head_commit),
            };
          },
        },
        raiseFinding: {
          type: new GraphQLNonNull(findingResult),
          args: { input: { type: new GraphQLNonNull(RaiseFindingInput) } },
          resolve: async (
            _source: undefined,
            args: RaiseFindingArguments,
            context: GraphQLContext,
          ): Promise<RaiseFindingResult> => {
            if (context.session.subject.length === 0) {
              return mutationFailure("forbidden", "A session is required to raise a finding.");
            }
            let trailId: string;
            let severity: TrailFinding["severity"];
            let source: TrailFinding["source"];
            let summary: string;
            let changeId: string | undefined;
            try {
              trailId = idOf(args.input.trailId, "Trail");
              severity = severityOf(args.input.severity);
              source = sourceOf(args.input.source);
              summary = textOf(args.input.summary);
              if (summary.trim().length === 0) {
                throw new QueryReadError("invalid_request", "summary must not be blank.");
              }
              changeId =
                args.input.changeId === null || args.input.changeId === undefined
                  ? undefined
                  : idOf(args.input.changeId, "TrailChange");
            } catch (error) {
              return failureOf(error);
            }
            if (!context.budget.spend(1)) {
              return mutationFailure(
                "limit_exceeded",
                "This request writes more rows than it may.",
              );
            }
            const finding: Mutable<TrailFindingCreateInput> = { severity, source, summary };
            if (args.input.file !== null && args.input.file !== undefined) {
              finding.file = args.input.file;
            }
            if (args.input.hunk !== null && args.input.hunk !== undefined) {
              finding.hunk = args.input.hunk;
            }
            if (changeId !== undefined) finding.changeId = changeId;
            let raised: TrailFindingValue | TrailWriteRefusal;
            try {
              raised = await context.writes.addTrailFinding(trailId, finding);
            } catch (error) {
              return failureOf(error);
            }
            if (raised.refused) return refusalOf(raised);
            return { __typename: "RaiseFindingPayload", finding: trailFindingView(raised) };
          },
        },
        keepHunk: hunkField("keep"),
        undoHunk: hunkField("undo"),
        applyHunk: hunkField("apply"),
      };
    },
  };
}

/** The model's object type by name. */
function objectTypeOf(
  objects: ReadonlyMap<string, GraphQLObjectType>,
  name: string,
): GraphQLObjectType {
  const type = objects.get(name);
  if (type === undefined) throw new Error("the model has no GraphQL type " + name);
  return type;
}

/** A non-empty id or version: an empty one would name nothing. */
function nonEmptyPath(value: string): string {
  if (value.length === 0) throw new QueryReadError("invalid_request", "The value is empty.");
  return value;
}

/**
 * The base and head of the Change a hunk action names.
 *
 * @returns The pair, or undefined when no Change has that id.
 *
 * @remarks
 * The pair is read from the Change's own row (through the Trail lists the context already has), so
 * a client cannot ask for a hunk of a commit pair the store never recorded. A Trail whose Changes
 * cannot be read is `unavailable`, not "no such change".
 */
async function pairOf(
  context: GraphQLContext,
  changeId: string,
): Promise<{ readonly base: string; readonly head: string } | undefined> {
  const trails = await context.reads.trails();
  for (const trail of trails) {
    if (trail.refused) continue;
    const changes = await context.reads.trailChanges(trail.id);
    for (const change of changes) {
      if (change.refused) continue;
      if (change.id === changeId) return { base: change.base_commit, head: change.head_commit };
    }
  }
  return undefined;
}

/** The rows of a Trail list read, or `unavailable` when the store refused one. */
function rowsOf<TValue extends object>(
  values: readonly (TValue | TrailWriteRefusal)[],
  context: GraphQLContext,
): readonly TValue[] {
  const rows = values.filter((value): value is TValue => isStoredValue(value));
  if (rows.length !== values.length) {
    console.error("graphql: a stored trail finding could not be read", context.requestId);
    throw new QueryReadError("unavailable", "The stored trail findings could not be read.");
  }
  return rows;
}

/** Whether a Trail list value is a row rather than a refusal. */
function isStoredValue<TValue extends object>(value: TValue | TrailWriteRefusal): value is TValue {
  return !("refused" in value && value.refused === true);
}
