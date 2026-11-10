// The model types that the SDL may reference. Adding an entity to the schema means
// adding it here, so an object field cannot point at a type that is not registered.
import type { Conversation, Project, Task, TaskStatus } from "../types.ts";

export interface EntityRegistry {
  readonly Project: Project;
  readonly Conversation: Conversation;
  readonly Task: Task;
}

export interface EnumRegistry {
  readonly TaskStatus: TaskStatus;
}
