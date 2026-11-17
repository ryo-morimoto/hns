import * as v from "valibot";
import type { Project, ProjectId, Task } from "@hns/core";
import type {
  ConversationCursor,
  ConversationListQuery,
  ConversationPage,
  IndexStateRow,
  Store,
} from "@hns/store";
import type { WorkerEnv } from "../edge/env.ts";
import { createRowBudget, type RowBudget } from "../edge/limits.ts";
import type { Session } from "../edge/session.ts";
import { projectFor, storeFor, StoreUnavailableError } from "../edge/store.ts";
import { QueryReadError } from "./failures.ts";

/**
 * The reads one GraphQL request performs.
 *
 * @remarks
 * A port per Query field, so each resolver names its source and tests replace one read without
 * a D1 database or a Durable Object.
 */
export interface GraphQLReads {
  readonly projects: () => Promise<readonly Project[]>;
  /**
   * The project with this id, or undefined.
   *
   * @remarks
   * The existence check runs before any other read names a project, so a client cannot make a
   * face address a Durable Object that D1 does not know.
   */
  readonly project: (projectId: ProjectId) => Promise<Project | undefined>;
  readonly tasks: (projectId: ProjectId) => Promise<readonly Task[]>;
  /**
   * One page of the D1 conversation index, scoped to the project.
   *
   * @remarks
   * The index is a copy: a conversation the Session has not written yet is missing here, and
   * its detail still comes from the object. The read never addresses a Durable Object.
   */
  readonly conversations: (
    projectId: ProjectId,
    query: ConversationReadQuery,
  ) => Promise<ConversationPage>;
  /** The project's index backlog and last failure, one row per workspace. */
  readonly indexState: (projectId: ProjectId) => Promise<IndexStateRow>;
}

/** What one conversation list read asks the index for. */
export interface ConversationReadQuery {
  /** Maximum rows; the resolver has already checked 1..maxRowsPerList. */
  readonly first: number;
  /** Return only rows after this keyset position. */
  readonly after?: ConversationCursor | undefined;
  /** Title substring; LIKE metacharacters match themselves. */
  readonly q?: string | undefined;
}

/** What a resolver asks the store to write. */
interface CreateProjectInput {
  readonly name: string;
  /** Already canonical; the resolver refuses an empty or non-canonical root first. */
  readonly workspaceRoot: string;
}

/**
 * The writes one GraphQL request performs.
 *
 * @remarks
 * Same shape as {@link GraphQLReads}: one port per mutation field, replaced in tests so the
 * resolver contract is proven without D1. A port throws `QueryReadError` for an expected outage;
 * the resolver turns that into a `MutationFailure` and never into a payload.
 */
export interface GraphQLWrites {
  readonly createProject: (input: CreateProjectInput) => Promise<Project>;
}

/** What one request carries into its resolvers. */
export interface GraphQLContext {
  /** The edge's correlation id; logged, never returned. */
  readonly requestId: string;
  /**
   * The verified caller.
   *
   * @remarks
   * The edge has proven only that the cookie is a valid session. A mutation resolver still
   * authorizes its own target (owner) before it writes.
   */
  readonly session: Session;
  readonly reads: GraphQLReads;
  readonly writes: GraphQLWrites;
  /** The rows this request may still read or write across every resolver. */
  readonly budget: RowBudget;
  /** The most rows one list field may return. */
  readonly maxRowsPerList: number;
}

/** How to build a context; tests pass `reads` and shrink the limits. */
export interface GraphQLContextOptions {
  readonly env: WorkerEnv;
  readonly requestId: string;
  readonly session: Session;
  readonly reads?: Partial<GraphQLReads> | undefined;
  readonly writes?: Partial<GraphQLWrites> | undefined;
  readonly maxRows: number;
  readonly maxRowsPerList: number;
}

/**
 * Run a store lookup, mapping an expected outage to `unavailable`.
 *
 * @internal
 * @remarks
 * Only `StoreUnavailableError` becomes a union failure. A corrupt row (`ValiError`) is a
 * defect and is rethrown, so the request answers 500 instead of a retryable outage.
 */
async function storeFailure<T>(requestId: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StoreUnavailableError) {
      console.error("graphql: store open failed", requestId, error.name);
      throw new QueryReadError("unavailable", error.message);
    }
    throw error;
  }
}

/** Open the store, mapping a missing binding or a failed open to `unavailable`. */
async function storeWith(env: WorkerEnv, requestId: string): Promise<Store> {
  return await storeFailure(requestId, () => storeFor(env));
}

/**
 * Run one store call, mapping an expected outage to `unavailable`.
 *
 * @internal
 * @remarks
 * A corrupt row (`ValiError`) is not an outage: it means the stored data disagrees with the
 * model, so it stays an unexpected failure and becomes a 500. A failed write is not reported as
 * a completed one.
 */
async function storeCall<T>(
  env: WorkerEnv,
  requestId: string,
  action: "read" | "write",
  work: (store: Store) => Promise<T>,
): Promise<T> {
  const store = await storeWith(env, requestId);
  try {
    return await work(store);
  } catch (error) {
    if (error instanceof v.ValiError) throw error;
    console.error(
      "graphql: store " + action + " failed",
      requestId,
      error instanceof Error ? error.name : "unknown",
    );
    throw new QueryReadError("unavailable", "The database " + action + " failed.");
  }
}

/**
 * Turn one resolver read into the store's query.
 *
 * @internal
 * @remarks
 * The optional fields are added one by one: `exactOptionalPropertyTypes` means a present key
 * cannot hold `undefined`, so a spread of a conditional object would widen the type.
 */
function pageQuery(projectId: ProjectId, query: ConversationReadQuery): ConversationListQuery {
  if (query.after === undefined) {
    return query.q === undefined
      ? { projectId, limit: query.first }
      : { projectId, limit: query.first, q: query.q };
  }
  return query.q === undefined
    ? { projectId, limit: query.first, after: query.after }
    : { projectId, limit: query.first, after: query.after, q: query.q };
}

/** The production reads: D1 for projects, tasks, and the conversation index. */
function defaultReads(env: WorkerEnv, requestId: string): GraphQLReads {
  return {
    projects: () => storeCall(env, requestId, "read", (store) => store.projects.list()),
    project: (projectId) => storeFailure(requestId, () => projectFor(env, projectId)),
    tasks: (projectId) => storeCall(env, requestId, "read", (store) => store.tasks.list(projectId)),
    conversations: (projectId, query) =>
      storeCall(env, requestId, "read", (store) =>
        store.conversations.page(pageQuery(projectId, query)),
      ),
    indexState: (projectId) =>
      storeCall(env, requestId, "read", (store) => store.indexState.read(projectId)),
  };
}

/** The production writes: D1 for the project table. */
function defaultWrites(env: WorkerEnv, requestId: string): GraphQLWrites {
  return {
    createProject: (input) =>
      storeCall(env, requestId, "write", (store) =>
        store.projects.create(input.name, input.workspaceRoot),
      ),
  };
}

/**
 * Build the context one request's resolvers share.
 *
 * @param options - The edge request facts, optional read replacements, and the row budget.
 * @returns The context; its reads are the overrides where given, the production reads otherwise.
 */
export function createContext(options: GraphQLContextOptions): GraphQLContext {
  const reads = defaultReads(options.env, options.requestId);
  const writes = defaultWrites(options.env, options.requestId);
  const readOverrides = options.reads ?? {};
  const writeOverrides = options.writes ?? {};
  return {
    requestId: options.requestId,
    session: options.session,
    budget: createRowBudget(options.maxRows),
    maxRowsPerList: options.maxRowsPerList,
    reads: {
      projects: readOverrides.projects ?? reads.projects,
      project: readOverrides.project ?? reads.project,
      tasks: readOverrides.tasks ?? reads.tasks,
      conversations: readOverrides.conversations ?? reads.conversations,
      indexState: readOverrides.indexState ?? reads.indexState,
    },
    writes: {
      createProject: writeOverrides.createProject ?? writes.createProject,
    },
  };
}
