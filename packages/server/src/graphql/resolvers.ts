import * as v from "valibot";
import { ProjectIdSchema, type ProjectId } from "@hns/core";
import { fromGlobalId, type GlobalIdResult } from "@hns/core/graphql";
import type { GraphQLContext } from "./context.ts";
import { queryFailure, QueryReadError, type QueryFailureView } from "./failures.ts";
import {
  conversationView,
  projectView,
  taskView,
  type ConversationView,
  type ProjectView,
  type TaskView,
} from "./views.ts";

/** The `first` argument every list field takes. */
interface ListArguments {
  readonly first?: number | null | undefined;
}

/** A list field scoped to one project. */
interface ProjectListArguments extends ListArguments {
  readonly projectId?: string | null | undefined;
}

interface ProjectListSuccess {
  readonly __typename: "ProjectList";
  readonly projects: readonly ProjectView[];
}

interface ConversationListSuccess {
  readonly __typename: "ConversationList";
  readonly conversations: readonly ConversationView[];
}

interface TaskListSuccess {
  readonly __typename: "TaskList";
  readonly tasks: readonly TaskView[];
}

/** One result union member. */
export type ProjectListResult = ProjectListSuccess | QueryFailureView;
/** One result union member. */
export type ConversationListResult = ConversationListSuccess | QueryFailureView;
/** One result union member. */
export type TaskListResult = TaskListSuccess | QueryFailureView;

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
 * @throws QueryReadError with `invalid_argument` when `first` is not an integer in 1..maximum.
 */
function pageSize(first: number | null | undefined, maximum: number): number {
  if (first === null || first === undefined) return maximum;
  if (!Number.isInteger(first) || first < 1 || first > maximum) {
    throw new QueryReadError(
      "invalid_argument",
      "first must be an integer between 1 and " + String(maximum) + ".",
    );
  }
  return first;
}

/**
 * Decode the required `projectId` argument.
 *
 * @internal
 * @throws QueryReadError with `invalid_argument` when the argument is missing, is not a global
 * id, or names a type other than `Project`.
 *
 * @remarks
 * The argument is a global id. A raw id is refused rather than guessed, so a client
 * cannot address a conversation id as a project id by accident.
 */
function requiredProjectId(value: string | null | undefined): ProjectId {
  if (value === null || value === undefined || value.length === 0) {
    throw new QueryReadError("invalid_argument", "projectId is required.");
  }
  const decoded: GlobalIdResult = fromGlobalId(value);
  if (!decoded.ok) {
    throw new QueryReadError("invalid_argument", "projectId must be a global id.");
  }
  if (decoded.value.type !== "Project") {
    throw new QueryReadError("invalid_argument", "projectId must name a Project.");
  }
  if (decoded.value.id.length === 0) {
    throw new QueryReadError("invalid_argument", "projectId must name a Project.");
  }
  return v.parse(ProjectIdSchema, decoded.value.id);
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
 * Resolve `Query.tasks` from D1.
 *
 * @param _source - Always undefined; Query fields have no parent value.
 * @param args - The project to scope to and the page size.
 * @param context - The request's reads and budget.
 * @returns The list, or a union failure for an invalid argument or an unavailable database.
 */
export async function resolveTasks(
  _source: undefined,
  args: ProjectListArguments,
  context: GraphQLContext,
): Promise<TaskListResult> {
  const result = await guarded(async () => {
    const projectId = requiredProjectId(args.projectId);
    const limit = pageSize(args.first, context.maxRowsPerList);
    spend(context, limit);
    const tasks = (await context.reads.tasks(projectId)).slice(0, limit);
    return tasks.map(taskView);
  });
  if (!result.ok) return result.failure;
  return { __typename: "TaskList", tasks: result.value };
}

/**
 * Resolve `Query.conversations` from the Session Durable Object.
 *
 * @param _source - Always undefined; Query fields have no parent value.
 * @param args - The project to scope to and the page size.
 * @param context - The request's reads and budget.
 * @returns The list, or a union failure for an invalid argument or an unreachable session.
 *
 * @remarks
 * The read addresses the project's own Session object (D080), so another project's
 * conversations never appear. The page is the object's newest page until 0149 indexes
 * conversations in D1.
 */
export async function resolveConversations(
  _source: undefined,
  args: ProjectListArguments,
  context: GraphQLContext,
): Promise<ConversationListResult> {
  const result = await guarded(async () => {
    const projectId = requiredProjectId(args.projectId);
    const limit = pageSize(args.first, context.maxRowsPerList);
    spend(context, limit);
    const conversations = (await context.reads.conversations(projectId, limit)).slice(0, limit);
    return conversations.map(conversationView);
  });
  if (!result.ok) return result.failure;
  return { __typename: "ConversationList", conversations: result.value };
}
