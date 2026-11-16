import * as v from "valibot";
import type { Conversation, Project, ProjectId, Task } from "@hns/core";
import { ConversationIdSchema, ProjectIdSchema } from "@hns/core";
import { openStore, type D1Binding, type Store } from "@hns/store";
import type { WorkerEnv } from "../edge/env.ts";
import { createRowBudget, type RowBudget } from "../edge/limits.ts";
import { SESSION_NAME } from "../session-name.ts";
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
  readonly conversations: (limit: number) => Promise<readonly Conversation[]>;
}

/** What one request carries into its resolvers. */
export interface GraphQLContext {
  /** The edge's correlation id; logged, never returned. */
  readonly requestId: string;
  readonly reads: GraphQLReads;
  /** The rows this request may still read across every resolver. */
  readonly budget: RowBudget;
  /** The most rows one list field may return. */
  readonly maxRowsPerList: number;
}

/** How to build a context; tests pass `reads` and shrink the limits. */
export interface GraphQLContextOptions {
  readonly env: WorkerEnv;
  readonly requestId: string;
  readonly reads?: Partial<GraphQLReads> | undefined;
  readonly maxRows: number;
  readonly maxRowsPerList: number;
}

const STORES = new WeakMap<D1Binding, Promise<Store>>();

/**
 * The D1 store for this isolate, opened once.
 *
 * @remarks
 * A rejected open is dropped from the cache so the next request retries instead of failing until
 * the isolate is evicted. 0149 replaces this memo with a provider that counts the opens.
 */
async function storeFor(env: WorkerEnv): Promise<Store> {
  const db = env.DB;
  if (db === undefined) {
    throw new QueryReadError("unavailable", "The database binding is not configured.");
  }
  const cached = STORES.get(db);
  if (cached !== undefined) return cached;
  const opened = openStore({ d1: db });
  STORES.set(db, opened);
  void opened.catch(() => {
    STORES.delete(db);
  });
  return opened;
}

/**
 * Read through the D1 store, mapping an expected outage to `unavailable`.
 *
 * @internal
 * @remarks
 * A corrupt row (`ValiError`) is not an outage: it means the stored data disagrees with the
 * model, so it stays an unexpected failure and becomes a 500.
 */
async function readStore<T>(
  env: WorkerEnv,
  requestId: string,
  read: (store: Store) => Promise<T>,
): Promise<T> {
  let store: Store;
  try {
    store = await storeFor(env);
  } catch (error) {
    if (error instanceof QueryReadError) throw error;
    console.error(
      "graphql: store open failed",
      requestId,
      error instanceof Error ? error.name : "unknown",
    );
    throw new QueryReadError("unavailable", "The database could not be opened.");
  }
  try {
    return await read(store);
  } catch (error) {
    if (error instanceof v.ValiError) throw error;
    console.error(
      "graphql: store read failed",
      requestId,
      error instanceof Error ? error.name : "unknown",
    );
    throw new QueryReadError("unavailable", "The database read failed.");
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
 * Read the newest conversations from the Session Durable Object.
 *
 * @internal
 * @remarks
 * One RPC per request; the resolver filters by project. Until 0149 indexes conversations in D1,
 * the filter sees only this page, so a quiet project can appear empty on a busy workspace.
 */
async function readConversations(
  env: WorkerEnv,
  requestId: string,
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
      .get(namespace.idFromName(SESSION_NAME))
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

/** The production reads: D1 for projects and tasks, the Session DO for conversations. */
function defaultReads(env: WorkerEnv, requestId: string): GraphQLReads {
  return {
    projects: () => readStore(env, requestId, (store) => store.projects.list()),
    tasks: (projectId) => readStore(env, requestId, (store) => store.tasks.list(projectId)),
    conversations: (limit) => readConversations(env, requestId, limit),
  };
}

/**
 * Build the context one request's resolvers share.
 *
 * @param options - The edge request facts, optional read replacements, and the row budget.
 * @returns The context; its reads are the overrides where given, the production reads otherwise.
 */
export function createContext(options: GraphQLContextOptions): GraphQLContext {
  const defaults = defaultReads(options.env, options.requestId);
  const overrides = options.reads ?? {};
  return {
    requestId: options.requestId,
    budget: createRowBudget(options.maxRows),
    maxRowsPerList: options.maxRowsPerList,
    reads: {
      projects: overrides.projects ?? defaults.projects,
      tasks: overrides.tasks ?? defaults.tasks,
      conversations: overrides.conversations ?? defaults.conversations,
    },
  };
}
