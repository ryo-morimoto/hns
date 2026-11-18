import * as v from "valibot";
import {
  ProjectIdSchema,
  TRAIL_KINDS,
  TRAIL_PRIORITIES,
  type ProjectId,
  type Trail,
} from "@hns/core";
import { fromGlobalId, publicEnumName } from "@hns/core/graphql";
import {
  GraphQLEnumType,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  GraphQLUnionType,
  type GraphQLFieldConfigMap,
} from "graphql";
import type { TrailRowValue, TrailWriteRefusal } from "@hns/store";
import type { GraphQLContext } from "../context.ts";
import { QueryReadError } from "../failures.ts";
import { trailView, type TrailView } from "../views.ts";
import { MutationFailureType, mutationFailure, type MutationFailureView } from "./failure.ts";
import type { MutationModule } from "./index.ts";

/** The successful member of `createTrail`: the Trail the store created. */
interface CreateTrailPayloadView {
  readonly __typename: "CreateTrailPayload";
  readonly trail: TrailView;
}

/** The successful member of `updateTrail`: the Trail as it now stands. */
interface UpdateTrailPayloadView {
  readonly __typename: "UpdateTrailPayload";
  readonly trail: TrailView;
}

/** The result union: the created Trail, or a typed refusal. */
type CreateTrailResult = CreateTrailPayloadView | MutationFailureView;

/** The result union: the updated Trail, or a typed refusal. */
type UpdateTrailResult = UpdateTrailPayloadView | MutationFailureView;

/** The title bound the conversation title already uses; a Trail title is the same kind of name. */
const MAX_TITLE_LENGTH = 200;
/** The free-text bound: a description is prose, but not an unbounded request body. */
const MAX_TEXT_LENGTH = 10_000;

/**
 * Turn a model vocabulary into GraphQL enum values.
 *
 * @internal
 * @param values - The closed list, in declaration order.
 * @returns One value per member; the value is the model string, unchanged.
 *
 * @remarks
 * The names follow the published output enums (`publicEnumName`: `feature` -> `FEATURE`,
 * `in_review` -> `IN_REVIEW`), so a client sends the value name it read from a Trail without a
 * translation table, and the two spellings cannot drift.
 */
function enumValues(values: readonly string[]): Record<string, { value: string }> {
  return Object.fromEntries(values.map((value) => [publicEnumName(value), { value }]));
}

/** The `TrailKind` input: the model's closed vocabulary, so a client cannot send another. */
const TrailKindInput = new GraphQLEnumType({
  name: "TrailKindInput",
  values: enumValues(TRAIL_KINDS),
});

/** The `TrailPriority` input: the model's closed vocabulary. */
const TrailPriorityInput = new GraphQLEnumType({
  name: "TrailPriorityInput",
  values: enumValues(TRAIL_PRIORITIES),
});

/** The arguments `createTrail` receives, as the schema declares them. */
interface CreateTrailArguments {
  readonly input: {
    readonly projectId: string;
    readonly title: string;
    readonly description?: string | null | undefined;
    readonly acceptance?: string | null | undefined;
    readonly kind?: string | null | undefined;
    readonly priority?: string | null | undefined;
  };
}

/** The arguments `updateTrail` receives, as the schema declares them. */
interface UpdateTrailArguments {
  readonly id: string;
  readonly input: {
    readonly title?: string | null | undefined;
    readonly description?: string | null | undefined;
    readonly acceptance?: string | null | undefined;
    readonly kind?: string | null | undefined;
    readonly priority?: string | null | undefined;
  };
}

/**
 * The `createTrail` input the model has a vocabulary for.
 *
 * @remarks
 * The state is not an input (D104): a Trail starts `draft` and moves by the transition table,
 * so a client cannot create one already `merged`. `kind` and `priority` are the model's
 * own closed unions, declared above from `@hns/core`'s lists, so a client can only send a value the
 * model names.
 */
const CreateTrailInput = new GraphQLInputObjectType({
  name: "CreateTrailInput",
  fields: {
    projectId: { type: new GraphQLNonNull(GraphQLID) },
    title: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: GraphQLString },
    acceptance: { type: GraphQLString },
    kind: { type: TrailKindInput },
    priority: { type: TrailPriorityInput },
  },
});

/** The `updateTrail` patch: every field optional, a present one replaces the stored value. */
const UpdateTrailInput = new GraphQLInputObjectType({
  name: "UpdateTrailInput",
  fields: {
    title: { type: GraphQLString },
    description: { type: GraphQLString },
    acceptance: { type: GraphQLString },
    kind: { type: TrailKindInput },
    priority: { type: TrailPriorityInput },
  },
});

/**
 * Check one enum input against the model's closed vocabulary.
 *
 * @internal
 * @throws QueryReadError with `invalid_request` when the value is not in the vocabulary.
 * @returns The value, narrowed to the vocabulary's union.
 */
function checkedEnum<T extends string>(values: readonly T[], value: string): T {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new QueryReadError("invalid_request", "The value is not one this build knows: " + value);
  }
  return found;
}

/**
 * Check a title.
 *
 * @internal
 * @throws QueryReadError with `invalid_request` when the trimmed title is empty or too long.
 */
function titleOf(value: string | null | undefined): string {
  const title = (value ?? "").trim();
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH) {
    throw new QueryReadError(
      "invalid_request",
      "title must be 1-" + String(MAX_TITLE_LENGTH) + " characters.",
    );
  }
  return title;
}

/**
 * Check one free-text field.
 *
 * @internal
 * @throws QueryReadError with `invalid_request` when it is longer than the bound.
 */
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
 * Decode a `Project` global id, and parse the raw id against its model schema.
 *
 * @internal
 * @throws QueryReadError with `invalid_request` when the value is not a Project id the model
 * accepts.
 */
function projectIdOf(value: string): ProjectId {
  const decoded = fromGlobalId(value);
  if (!decoded.ok || decoded.value.type !== "Project") {
    throw new QueryReadError("invalid_request", "The id must be a Project global id.");
  }
  return v.parse(ProjectIdSchema, decoded.value.id);
}

/**
 * Decode a `Trail` global id.
 *
 * @internal
 * @throws QueryReadError with `invalid_request` when the value is not a Trail global id.
 */
function trailIdOf(value: string): string {
  const decoded = fromGlobalId(value);
  if (!decoded.ok || decoded.value.type !== "Trail") {
    throw new QueryReadError("invalid_request", "The id must be a Trail global id.");
  }
  return decoded.value.id;
}

/**
 * Map a store refusal to the failure a mutation answers with.
 *
 * @internal
 * @remarks
 * `not_found` and `corrupt_row` are answers the caller can tell apart from their own mistake.
 * `invalid_transition` and `invalid_change` cannot come from these two fields (neither writes a
 * state or a Change), so they are defects here and are thrown as such.
 */
function refusalOf(refusal: TrailWriteRefusal): MutationFailureView {
  switch (refusal.kind) {
    case "not_found":
      return mutationFailure("not_found", "No trail has this id.");
    case "corrupt_row":
      return mutationFailure("unavailable", "The stored trail could not be read.");
    case "invalid_transition":
    case "invalid_change":
      throw new Error("a trail field write cannot refuse as " + refusal.kind);
    default:
      return assertNever(refusal);
  }
}

/** Fail on a refusal this module did not expect. */
function assertNever(value: never): never {
  throw new Error("unexpected trail refusal: " + JSON.stringify(value));
}

/**
 * Turn a check's exception into the failure member it stands for.
 *
 * @internal
 * @param error - What a check threw. A `catch` parameter is `unknown` by the language, and this
 * function is the parse: two exception classes are expected, and everything else is a defect.
 * @returns The failure member the exception stands for.
 * @throws The error itself when it is neither a `QueryReadError` nor a `ValiError`, so the
 * handler answers 500 instead of reporting a defect as a caller mistake.
 *
 * @remarks
 * The checks above throw `QueryReadError`; the one `ValiError` a resolver can provoke is the
 * project id failing its model schema. A `Trail` id is not parsed against a schema (any non-empty
 * id is a legal Trail id), so nothing else is expected.
 */
/* oxlint-disable anti-slop/no-unknown-parameters --
   A catch parameter is unknown by the language (useUnknownInCatchVariables), and this function is
   where it is parsed into the two failure classes the resolver answers with; nothing else is
   accepted, and the rest is rethrown.
*/
function failureOf(error: unknown): MutationFailureView {
  /* oxlint-enable anti-slop/no-unknown-parameters */
  if (error instanceof QueryReadError) return mutationFailure(error.code, error.message);
  if (error instanceof v.ValiError) return mutationFailure("invalid_request", error.message);
  throw error;
}

/** The fields a caller may set, after the resolver has checked them. */
interface TrailFields {
  readonly title: string;
  readonly description: string;
  readonly acceptance: string;
  readonly kind: Trail["kind"];
  readonly priority: Trail["priority"];
}

/** The patch `updateTrail` sends: only the fields the caller gave. */
interface UpdateTrailPatch {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly acceptance?: string | undefined;
  readonly kind?: Trail["kind"] | undefined;
  readonly priority?: Trail["priority"] | undefined;
}

/**
 * Build the patch from an update input.
 *
 * @internal
 * @remarks
 * A field is present only when the client gave it: `exactOptionalPropertyTypes` means a present
 * key cannot hold `undefined`, and the store takes "absent" to mean "keep the stored value".
 */
function patchOf(input: UpdateTrailArguments["input"]): UpdateTrailPatch {
  const patch: {
    -readonly [K in keyof UpdateTrailPatch]: UpdateTrailPatch[K];
  } = {};
  if (input.title !== null && input.title !== undefined) patch.title = titleOf(input.title);
  if (input.description !== null && input.description !== undefined) {
    patch.description = textOf(input.description);
  }
  if (input.acceptance !== null && input.acceptance !== undefined) {
    patch.acceptance = textOf(input.acceptance);
  }
  if (input.kind !== null && input.kind !== undefined) {
    patch.kind = checkedEnum(TRAIL_KINDS, input.kind);
  }
  if (input.priority !== null && input.priority !== undefined) {
    patch.priority = checkedEnum(TRAIL_PRIORITIES, input.priority);
  }
  return patch;
}

/**
 * The Trail write face (D104): `createTrail` and `updateTrail`.
 *
 * @returns The module that adds the two fields to the Mutation root.
 *
 * @remarks
 * **The creator is the session's subject**, not an argument: a caller cannot write a Trail under
 * someone else's name, and this build has one owner, so there is no per-project authorization to
 * check beyond a subject existing (the same rule `createProject` states).
 *
 * **The project must exist** before a Trail is written into it, so a typo is `invalid_request`
 * instead of a Trail no screen lists: the Sidebar reads a workspace's Trails.
 *
 * **`updateTrail` does not move the state.** A state move is the transition table's, not a
 * patch's; the mutation that asks the table arrives with 0232's review face, which is where a
 * person decides.
 */
export function trailModule(): MutationModule {
  return {
    name: "trails",
    fields: (
      objects: ReadonlyMap<string, GraphQLObjectType>,
      overrides: ReadonlyMap<string, GraphQLObjectType>,
    ): GraphQLFieldConfigMap<undefined, GraphQLContext> => {
      // The Query root's Trail (the row plus the lists it resolves from its id), not the model's:
      // a payload that named the model's would make the schema hold two types called Trail.
      const trail = overrides.get("Trail") ?? objects.get("Trail");
      if (trail === undefined) throw new Error("the model has no GraphQL type Trail");
      const createPayload = new GraphQLObjectType({
        name: "CreateTrailPayload",
        fields: { trail: { type: new GraphQLNonNull(trail) } },
      });
      const createResult = new GraphQLUnionType({
        name: "CreateTrailResult",
        types: [createPayload, MutationFailureType],
        resolveType: (value: CreateTrailResult): string => value.__typename,
      });
      const updatePayload = new GraphQLObjectType({
        name: "UpdateTrailPayload",
        fields: { trail: { type: new GraphQLNonNull(trail) } },
      });
      const updateResult = new GraphQLUnionType({
        name: "UpdateTrailResult",
        types: [updatePayload, MutationFailureType],
        resolveType: (value: UpdateTrailResult): string => value.__typename,
      });
      return {
        createTrail: {
          type: new GraphQLNonNull(createResult),
          args: { input: { type: new GraphQLNonNull(CreateTrailInput) } },
          resolve: async (
            _source: undefined,
            args: CreateTrailArguments,
            context: GraphQLContext,
          ): Promise<CreateTrailResult> => {
            if (context.session.subject.length === 0) {
              return mutationFailure("forbidden", "A session is required to create a trail.");
            }
            let fields: TrailFields;
            let projectId: ProjectId;
            try {
              projectId = projectIdOf(args.input.projectId);
              fields = {
                title: titleOf(args.input.title),
                description: textOf(args.input.description),
                acceptance: textOf(args.input.acceptance),
                kind: checkedEnum(TRAIL_KINDS, args.input.kind ?? "feature"),
                priority: checkedEnum(TRAIL_PRIORITIES, args.input.priority ?? "normal"),
              };
            } catch (error) {
              return failureOf(error);
            }
            if ((await context.reads.project(projectId)) === undefined) {
              return mutationFailure("invalid_request", "No project has this id.");
            }
            if (!context.budget.spend(1)) {
              return mutationFailure(
                "limit_exceeded",
                "This request writes more rows than it may.",
              );
            }
            let created: TrailRowValue | TrailWriteRefusal;
            try {
              created = await context.writes.createTrail({
                projectId,
                title: fields.title,
                description: fields.description,
                acceptance: fields.acceptance,
                kind: fields.kind,
                priority: fields.priority,
                createdBy: context.session.subject,
              });
            } catch (error) {
              return failureOf(error);
            }
            if (created.refused) return refusalOf(created);
            return { __typename: "CreateTrailPayload", trail: trailView(created) };
          },
        },
        updateTrail: {
          type: new GraphQLNonNull(updateResult),
          args: {
            id: { type: new GraphQLNonNull(GraphQLID) },
            input: { type: new GraphQLNonNull(UpdateTrailInput) },
          },
          resolve: async (
            _source: undefined,
            args: UpdateTrailArguments,
            context: GraphQLContext,
          ): Promise<UpdateTrailResult> => {
            if (context.session.subject.length === 0) {
              return mutationFailure("forbidden", "A session is required to change a trail.");
            }
            let id: string;
            let patch: UpdateTrailPatch;
            try {
              id = trailIdOf(args.id);
              patch = patchOf(args.input);
            } catch (error) {
              return failureOf(error);
            }
            if (!context.budget.spend(1)) {
              return mutationFailure(
                "limit_exceeded",
                "This request writes more rows than it may.",
              );
            }
            let updated: TrailRowValue | TrailWriteRefusal | undefined;
            try {
              updated = await context.writes.updateTrail(id, patch);
            } catch (error) {
              return failureOf(error);
            }
            if (updated === undefined) {
              return mutationFailure("not_found", "No trail has this id.");
            }
            if (updated.refused) return refusalOf(updated);
            return { __typename: "UpdateTrailPayload", trail: trailView(updated) };
          },
        },
      };
    },
  };
}
