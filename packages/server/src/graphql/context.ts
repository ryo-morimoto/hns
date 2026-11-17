import * as v from "valibot";
import type { Conversation, Project, ProjectId, Task } from "@hns/core";
import { ConversationIdSchema, ProjectIdSchema } from "@hns/core";
import type { Store } from "@hns/store";
import type { WorkerEnv } from "../edge/env.ts";
import { createRowBudget, type RowBudget } from "../edge/limits.ts";
import type { Session } from "../edge/session.ts";
import { storeFor, StoreUnavailableError } from "../edge/store.ts";
import { sessionNameFor } from "../session-name.ts";
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
  readonly tasks: (projectId: ProjectId) => Promise<readonly Task[]>;
  readonly conversations: (projectId: ProjectId, limit: number) => Promise<readonly Conversation[]>;
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

/** Open the store, mapping a missing binding or a failed open to `unavailable`. */
async function storeWith(env: WorkerEnv, requestId: string): Promise<Store> {
  try {
    return await storeFor(env);
  } catch (error) {
    if (error instanceof StoreUnavailableError) {
      console.error("graphql: store open failed", requestId, error.name);
      throw new QueryReadError("unavailable", error.message);
    }
    throw error;
  }
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

// The list envelope the Session RPC returns; malformed JSON is a defect, not a client failure.
const ConversationRpcSchema = v.object({
  id: ConversationIdSchema,
  project_id: ProjectIdSchema,
  title: v.string(),
  created_at: v.string(),
  updated_at: v.nullable(v.string()),
  archived: v.boolean(),
  deleted_at: v.nullable(v.string()),
});

const ConversationListRpcSchema = v.object({
  ok: v.literal(true),
  conversations: v.array(ConversationRpcSchema),
});

/**
 * Read the newest conversations from the project's own Session Durable Object.
 *
 * @internal
 * @remarks
 * One RPC per request to `sessionNameFor(projectId)`. The object holds one project's
 * conversations (D080), so the read is isolated by the object, not by a filter here. Until 0149
 * indexes conversations in D1, this is still one page.
 */
async function readConversations(
  env: WorkerEnv,
  requestId: string,
  projectId: ProjectId,
  limit: number,
): Promise<readonly Conversation[]> {
  const namespace = env.SESSION;
  if (namespace === undefined) {
    throw new QueryReadError("unavailable", "The session binding is not configured.");
  }
  const url = "https://session.internal/rpc/conversations?limit=" + String(limit);
  let response: Response;
  try {
    response = await namespace
      .get(namespace.idFromName(sessionNameFor(projectId)))
      .fetch(new Request(url, { method: "GET", headers: { "x-request-id": requestId } }));
  } catch (error) {
    console.error(
      "graphql: session fetch failed",
      requestId,
      error instanceof Error ? error.name : "unknown",
    );
    throw new QueryReadError("unavailable", "The session could not be reached.");
  }
  if (response.status !== 200) {
    throw new QueryReadError("unavailable", "The session read failed.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new QueryReadError("unavailable", "The session returned an unreadable response.");
  }
  const parsed = v.safeParse(ConversationListRpcSchema, body);
  if (!parsed.success) throw new Error("session RPC returned an invalid conversation list");
  return parsed.output.conversations;
}

/** The production reads: D1 for projects and tasks, the project's Session DO for conversations. */
function defaultReads(env: WorkerEnv, requestId: string): GraphQLReads {
  return {
    projects: () => storeCall(env, requestId, "read", (store) => store.projects.list()),
    tasks: (projectId) => storeCall(env, requestId, "read", (store) => store.tasks.list(projectId)),
    conversations: (projectId, limit) => readConversations(env, requestId, projectId, limit),
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
      tasks: readOverrides.tasks ?? reads.tasks,
      conversations: readOverrides.conversations ?? reads.conversations,
    },
    writes: {
      createProject: writeOverrides.createProject ?? writes.createProject,
    },
  };
}
