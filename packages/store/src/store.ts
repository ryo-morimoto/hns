import type { StoreContext, StoreOptions } from "./db.ts";
import { createContext, openDatabase } from "./db.ts";
import { migrate } from "./migrate.ts";
import { automationRepository, type AutomationRepository } from "./repositories/automations.ts";
import {
  conversationRepository,
  type ConversationRepository,
} from "./repositories/conversations.ts";
import { eventRepository, type EventRepository } from "./repositories/events.ts";
import {
  projectRepository,
  taskRepository,
  type ProjectRepository,
  type TaskRepository,
} from "./repositories/projects.ts";
import { usageRepository, type UsageRepository } from "./repositories/usage.ts";
import { workflowRepository, type WorkflowRepository } from "./repositories/workflows.ts";

/**
 * The opened store: one repository per model area, all sharing one connection.
 *
 * @remarks
 * The repositories share the connection, the clock, and the id source. A repository call
 * that writes runs in its own transaction and never spans repositories. A store must not
 * be used after {@link Store.close}.
 */
export interface Store {
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly conversations: ConversationRepository;
  readonly events: EventRepository;
  readonly workflows: WorkflowRepository;
  readonly automations: AutomationRepository;
  readonly usage: UsageRepository;
  /** Close the underlying connection. Calls made after this throw from the closed connection. */
  close(): void;
}

/**
 * Open the SQLite store, apply migrations, and seed the default project.
 *
 * @remarks
 * The default project (id `default`) exists when this returns, so a caller can create
 * related rows without choosing a project first. Migrations are idempotent, so reopening
 * an existing database is safe. If a migration or the seed fails, the connection is closed
 * before the error propagates.
 *
 * @param options - The database path and optional clock and id injection.
 * @returns The opened store; the caller owns it and must call {@link Store.close}.
 * @throws Error if the database is newer than this build or a migration fails.
 * @throws ValiError if the injected clock does not return an ISO timestamp.
 */
export function openStore(options: StoreOptions): Store {
  const db = openDatabase(options.path);
  try {
    const context: StoreContext = createContext(db, options);
    migrate(db);
    const projects = projectRepository(context);
    projects.ensureDefault();
    return {
      projects,
      tasks: taskRepository(context),
      conversations: conversationRepository(context),
      events: eventRepository(context),
      workflows: workflowRepository(context),
      automations: automationRepository(context),
      usage: usageRepository(context),
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
