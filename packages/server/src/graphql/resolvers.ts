import * as v from "valibot";
import { ProjectIdSchema, type ProjectId, type Trail } from "@hns/core";
import { fromGlobalId, type GlobalIdResult } from "@hns/core/graphql";
import type { ConversationCursor, TrailRowValue, TrailWriteRefusal } from "@hns/store";
import type { ConversationReadQuery, GraphQLContext } from "./context.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { queryFailure, QueryReadError, type QueryFailureView } from "./failures.ts";
import {
  conversationView,
  indexStateView,
  machineView,
  projectView,
  trailView,
  type ConversationView,
  type IndexStateView,
  type MachineView,
  type ProjectView,
  type TrailView,
} from "./views.ts";

/** The `first` argument every list field takes. */
interface ListArguments {
  readonly first?: number | null | undefined;
}

/** A list field scoped to one project. */
interface ProjectListArguments extends ListArguments {
  readonly projectId?: string | null | undefined;
}

/** The conversation list's cursor and title search. */
interface ConversationArguments extends ProjectListArguments {
  readonly after?: string | null | undefined;
  readonly q?: string | null | undefined;
}

interface ProjectListSuccess {
  readonly __typename: "ProjectList";
  readonly projects: readonly ProjectView[];
}

interface ConversationListSuccess {
  readonly __typename: "ConversationList";
  readonly conversations: readonly ConversationView[];
  /** The position to continue from, or null when this page is the last one. */
  readonly nextCursor: string | null;
}

interface IndexStateSuccess extends IndexStateView {
  readonly __typename: "IndexState";
}

interface TrailListSuccess {
  readonly __typename: "TrailList";
  readonly trails: readonly TrailView[];
}

interface TrailPayloadSuccess {
  readonly __typename: "TrailPayload";
  readonly trail: TrailView;
}

interface MachineListSuccess {
  readonly __typename: "MachineList";
  readonly machines: readonly MachineView[];
}

/** One result union member. */
export type ProjectListResult = ProjectListSuccess | QueryFailureView;
/** One result union member. */
export type ConversationListResult = ConversationListSuccess | QueryFailureView;
/** One result union member. */
export type IndexStateResult = IndexStateSuccess | QueryFailureView;
/** One result union member. */
export type TrailListResult = TrailListSuccess | QueryFailureView;
/** One result union member. */
export type TrailResult = TrailPayloadSuccess | QueryFailureView;
/** One result union member. */
export type MachineListResult = MachineListSuccess | QueryFailureView;

type Guarded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: QueryFailureView };

/**
 * Run a read, turning an expected failure into a union member.
 *
 * @internal
 * @remarks
 * Anything that is not a `QueryReadError` is a defect and is rethrown, so the handler answers
 * 500 instead of reporting a clean failure.
 */
async function guarded<T>(read: () => Promise<T>): Promise<Guarded<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    if (error instanceof QueryReadError) {
      return { ok: false, failure: queryFailure(error.code, error.message) };
    }
    throw error;
  }
}

/**
 * Parse `first`, defaulting to the page cap.
 *
 * @internal
 * @throws QueryReadError with `invalid_request` when `first` is not an integer in 1..maximum.
 */
function pageSize(first: number | null | undefined, maximum: number): number {
  if (first === null || first === undefined) return maximum;
  if (!Number.isInteger(first) || first < 1 || first > maximum) {
    throw new QueryReadError(
      "invalid_request",
      "first must be an integer between 1 and " + String(maximum) + ".",
    );
  }
  return first;
}

/**
 * Decode the required `projectId` argument.
 *
 * @internal
 * @throws QueryReadError with `invalid_request` when the argument is missing, is not a global
 * id, or names a type other than `Project`.
 *
 * @remarks
 * The argument is a global id. A raw id is refused rather than guessed, so a client
 * cannot address a conversation id as a project id by accident.
 */
function requiredProjectId(value: string | null | undefined): ProjectId {
  if (value === null || value === undefined || value.length === 0) {
    throw new QueryReadError("invalid_request", "projectId is required.");
  }
  const decoded: GlobalIdResult = fromGlobalId(value);
  if (!decoded.ok) {
    throw new QueryReadError("invalid_request", "projectId must be a global id.");
  }
  if (decoded.value.type !== "Project") {
    throw new QueryReadError("invalid_request", "projectId must name a Project.");
  }
  if (decoded.value.id.length === 0) {
    throw new QueryReadError("invalid_request", "projectId must name a Project.");
  }
  return v.parse(ProjectIdSchema, decoded.value.id);
}

/**
 * Decode the required `Trail` global id.
 *
 * @internal
 * @throws QueryReadError with `invalid_request` when the value is missing, is not a global id, or
 * names a type other than `Trail`.
 *
 * @remarks
 * The raw id is what the store holds (`trail-<task id>` for a backfilled Trail, which keeps a
 * backfilled row reachable after the `tasks` table stops being read); the global id is what the
 * wire carries. A raw id is refused rather than guessed.
 */
function requiredTrailId(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) {
    throw new QueryReadError("invalid_request", "id is required.");
  }
  const decoded: GlobalIdResult = fromGlobalId(value);
  if (!decoded.ok || decoded.value.type !== "Trail") {
    throw new QueryReadError("invalid_request", "id must be a Trail global id.");
  }
  return decoded.value.id;
}

/**
 * Build the index read: the optional keys are present only when the client gave them.
 *
 * @internal
 * @remarks
 * `exactOptionalPropertyTypes` means a present key cannot hold `undefined`, so the four
 * combinations are written out instead of spreading a conditional object.
 */
function readOf(
  first: number,
  after: ConversationCursor | undefined,
  q: string | undefined,
): ConversationReadQuery {
  if (after === undefined) return q === undefined ? { first } : { first, q };
  return q === undefined ? { first, after } : { first, after, q };
}

/**
 * Decode the `after` argument.
 *
 * @internal
 * @throws QueryReadError with `invalid_request` when the value is present but is not a cursor.
 * @returns The position, or undefined when the argument is absent.
 */
function cursorOf(after: string | null | undefined): ConversationCursor | undefined {
  if (after === null || after === undefined) return undefined;
  const cursor = decodeCursor(after);
  if (cursor === undefined) {
    throw new QueryReadError("invalid_request", "after must be a conversation cursor.");
  }
  return cursor;
}

/**
 * Normalise the `q` argument.
 *
 * @internal
 * @returns The trimmed search term, or undefined when absent or empty.
 */
function searchOf(q: string | null | undefined): string | undefined {
  if (q === null || q === undefined) return undefined;
  const trimmed = q.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Charge the page to the request's row budget before the read.
 *
 * @internal
 * @throws QueryReadError with `limit_exceeded` when the page does not fit.
 *
 * @remarks
 * The page size is charged rather than the rows returned, so an over-budget request is refused
 * before it touches D1 or the Session. Without a `LIMIT` in the store queries the read itself
 * still returns every row until 0149 adds the index and the limit.
 */
function spend(context: GraphQLContext, rows: number): void {
  if (!context.budget.spend(rows)) {
    throw new QueryReadError("limit_exceeded", "This request reads more rows than it may.");
  }
}

/**
 * Resolve `Query.machines`: the registry D1 holds, with a throttled reachability probe (0148).
 *
 * @param _source - Always undefined; Query fields have no parent value.
 * @param args - The `first` page size.
 * @param context - The request's reads and budget.
 * @returns The list with each machine's status, or a union failure.
 *
 * @remarks
 * The read is the registry, not a cached connection table (D049). The production port probes each
 * non-revoked machine before it answers, so a status read here reflects the probe; the registry's
 * 30-second throttle decides whether the probe moves `lastSeen` (D087 U-03). A revoked machine is
 * listed as `REVOKED` and never probed.
 */
export async function resolveMachines(
  _source: undefined,
  args: ListArguments,
  context: GraphQLContext,
): Promise<MachineListResult> {
  const result = await guarded(async () => {
    const limit = pageSize(args.first, context.maxRowsPerList);
    spend(context, limit);
    const machines = (await context.reads.machines()).slice(0, limit);
    return machines.map((machine) => machineView(machine, context.session.subject));
  });
  if (!result.ok) return result.failure;
  return { __typename: "MachineList", machines: result.value };
}

/**
 * Resolve `Query.projects`.
 *
 * @param _source - Always undefined; Query fields have no parent value.
 * @param args - The `first` page size.
 * @param context - The request's reads and budget.
 * @returns The list, or a union failure for an invalid argument or an unavailable database.
 */
export async function resolveProjects(
  _source: undefined,
  args: ListArguments,
  context: GraphQLContext,
): Promise<ProjectListResult> {
  const result = await guarded(async () => {
    const limit = pageSize(args.first, context.maxRowsPerList);
    spend(context, limit);
    const projects = (await context.reads.projects()).slice(0, limit);
    return projects.map(projectView);
  });
  if (!result.ok) return result.failure;
  return { __typename: "ProjectList", projects: result.value };
}

/**
 * Turn the store's Trail answer into the Trail, or the typed failure it stands for.
 *
 * @internal
 * @remarks
 * The store answers a Trail's absence and a row it cannot read as refusals, because its callers
 * can act on both. A missing Trail is `not_found`; a corrupt row is `unavailable` — the caller
 * can retry a broken read and cannot repair it, and the row is not the one they asked a missing
 * id about.
 */
function trailOrFailure(value: TrailRowValue | TrailWriteRefusal): Trail {
  if (!value.refused) return value;
  throw value.kind === "not_found"
    ? new QueryReadError("not_found", "No trail has this id.")
    : new QueryReadError("unavailable", "The stored trail could not be read.");
}

/**
 * Resolve `Query.trails`: the Trails of one project, or of every project.
 *
 * @param _source - Always undefined; Query fields have no parent value.
 * @param args - The optional project to scope to and the page size.
 * @param context - The request's reads and budget.
 * @returns The list, or a union failure for an invalid argument or an unreadable row.
 *
 * @remarks
 * Without `projectId` the list spans every project, which is what a client that shows one Sidebar
 * for all workspaces reads. The store returns newest first; the page is the first `first` rows.
 * A list that holds one unreadable row is refused whole (`unavailable`) rather than answered
 * short: a Sidebar that silently hid a Trail would hide exactly the one that is broken.
 */
export async function resolveTrails(
  _source: undefined,
  args: ProjectListArguments,
  context: GraphQLContext,
): Promise<TrailListResult> {
  const result = await guarded(async () => {
    const projectId =
      args.projectId === null || args.projectId === undefined
        ? undefined
        : requiredProjectId(args.projectId);
    const limit = pageSize(args.first, context.maxRowsPerList);
    spend(context, limit);
    const rows = await context.reads.trails(projectId);
    return rows.map(trailOrFailure).slice(0, limit).map(trailView);
  });
  if (!result.ok) return result.failure;
  return { __typename: "TrailList", trails: result.value };
}

/**
 * Resolve `Query.trail`: one Trail by its global id.
 *
 * @param _source - Always undefined; Query fields have no parent value.
 * @param args - The Trail's global id.
 * @param context - The request's reads and budget.
 * @returns The Trail, or a typed failure for a malformed id, a missing row, or an unreadable one.
 *
 * @remarks
 * The argument is a global id of type `Trail`, so another type's id (or a raw one) is refused
 * before the store is asked. A missing Trail is `not_found` and not an empty answer: the
 * difference is what lets a screen say "deleted" rather than "loading".
 */
export async function resolveTrail(
  _source: undefined,
  args: { readonly id: string },
  context: GraphQLContext,
): Promise<TrailResult> {
  const result = await guarded(async () => {
    const id = requiredTrailId(args.id);
    spend(context, 1);
    return trailView(trailOrFailure(await context.reads.trail(id)));
  });
  if (!result.ok) return result.failure;
  return { __typename: "TrailPayload", trail: result.value };
}

/**
 * Resolve `Query.conversations` from the D1 index.
 *
 * @param _source - Always undefined; Query fields have no parent value.
 * @param args - The project to scope to, the page size, the keyset cursor, and a title search.
 * @param context - The request's reads and budget.
 * @returns The list with the next cursor, or a union failure.
 *
 * @remarks
 * The project is checked in D1 before the index is read, so an unknown id is a typed
 * `invalid_request` and never reaches a Durable Object (D080). The read is the index only: a
 * conversation the Session has not written yet is missing here, and its detail still comes from
 * the object. A cursor that is not one this server issued is refused, not guessed.
 */
export async function resolveConversations(
  _source: undefined,
  args: ConversationArguments,
  context: GraphQLContext,
): Promise<ConversationListResult> {
  const result = await guarded(async () => {
    const projectId = requiredProjectId(args.projectId);
    const first = pageSize(args.first, context.maxRowsPerList);
    const project = await context.reads.project(projectId);
    if (project === undefined) {
      throw new QueryReadError("invalid_request", "No project has this id.");
    }
    const after = cursorOf(args.after);
    const q = searchOf(args.q);
    spend(context, first);
    const page = await context.reads.conversations(projectId, readOf(first, after, q));
    return {
      conversations: page.items.map(conversationView),
      nextCursor: encodeCursor(page.nextCursor),
    };
  });
  if (!result.ok) return result.failure;
  return {
    __typename: "ConversationList",
    conversations: result.value.conversations,
    nextCursor: result.value.nextCursor,
  };
}

/**
 * Resolve `Query.indexState` for one project's workspace.
 *
 * @param _source - Always undefined; Query fields have no parent value.
 * @param args - The project whose Session object owns the index.
 * @param context - The request's reads and budget.
 * @returns The backlog and last failure, or a union failure for an unknown project.
 *
 * @remarks
 * The caller is the workspace owner: the edge has already verified the session, and this build
 * has one owner. Owner scoping by user arrives with the accounts face; until then the project
 * check is what keeps one workspace's backlog from being read as another's.
 */
export async function resolveIndexState(
  _source: undefined,
  args: ProjectListArguments,
  context: GraphQLContext,
): Promise<IndexStateResult> {
  const result = await guarded(async () => {
    const projectId = requiredProjectId(args.projectId);
    const project = await context.reads.project(projectId);
    if (project === undefined) {
      throw new QueryReadError("invalid_request", "No project has this id.");
    }
    return context.reads.indexState(projectId);
  });
  if (!result.ok) return result.failure;
  return { __typename: "IndexState", ...indexStateView(result.value) };
}
