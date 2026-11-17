import { createContext, type StoreContext, type StoreHooks } from "./db.ts";
import { migrate as migrateSql } from "./migrate.ts";
import { automationRepository, type AutomationRepository } from "./repositories/automations.ts";
import {
  conversationRepository,
  type ConversationRepository,
} from "./repositories/conversations.ts";
import { indexStateRepository, type IndexStateRepository } from "./repositories/index-state.ts";
import {
  projectRepository,
  taskRepository,
  type ProjectRepository,
  type TaskRepository,
} from "./repositories/projects.ts";
import { workflowRepository, type WorkflowRepository } from "./repositories/workflows.ts";
import { createSql, type D1Binding } from "./sql.ts";

/**
 * The opened store: one repository per model area, all sharing one D1 database.
 *
 * @remarks
 * The repositories share the adapter, the clock, and the id source. A repository call that
 * writes is one statement, or one D1 batch when it spans statements; D1 has no interactive
 * transaction. A store must not be used after {@link Store.close}.
 *
 * The surface is what a face uses: the read side of every model area, and the writes the
 * Worker performs today. A write no face performs yet (workflow graph edits and runs,
 * automation and firing edits, conversation registration and renames) is not reachable from
 * `env.DB` until the issue that needs it adds it here with that caller. The Session object
 * writes conversations through `@hns/store/conversation-index`, not through this store (D078).
 */
export interface Store {
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly conversations: ConversationRepository;
  /** The conversation index's backlog and last failure, one row per workspace. */
  readonly indexState: IndexStateRepository;
  readonly workflows: WorkflowRepository;
  readonly automations: AutomationRepository;
  /** Close the adapter. Calls made after this throw from the closed adapter. */
  close(): Promise<void>;
}

/** How to open the store: a D1 binding plus the test hooks. */
export interface StoreOptions extends StoreHooks {
  /** The D1 binding to use (the Worker's `env.DB`, or miniflare's database in tests). */
  readonly d1: D1Binding;
}

/**
 * Open the D1 store, apply migrations, and seed the default project.
 *
 * @remarks
 * The default project (id `default`) exists when this returns, so a caller can create
 * related rows without choosing a project first. Migrations are idempotent, so reopening an
 * existing database is safe; opening a store once per Worker isolate is enough. If a
 * migration or the seed fails, the adapter is closed before the error propagates.
 *
 * @param options - The D1 binding and optional clock and id injection.
 * @returns The opened store; the caller owns it and must call {@link Store.close}.
 * @throws Error if the database is newer than this build or a migration fails.
 * @throws ValiError if the injected clock does not return an ISO timestamp.
 */
export async function openStore(options: StoreOptions): Promise<Store> {
  const sql = createSql(options.d1);
  try {
    const context: StoreContext = createContext(sql, options);
    await migrateSql(sql);
    const projects = projectRepository(context);
    await projects.ensureDefault();
    return {
      projects,
      tasks: taskRepository(context),
      conversations: conversationRepository(context),
      indexState: indexStateRepository(context),
      workflows: workflowRepository(context),
      automations: automationRepository(context),
      close: () => sql.close(),
    };
  } catch (error) {
    await sql.close();
    throw error;
  }
}
