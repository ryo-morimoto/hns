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

export interface Store {
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly conversations: ConversationRepository;
  readonly events: EventRepository;
  readonly workflows: WorkflowRepository;
  readonly automations: AutomationRepository;
  readonly usage: UsageRepository;
  close(): void;
}

/** Open the SQLite store, apply migrations, and seed the default project. */
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
