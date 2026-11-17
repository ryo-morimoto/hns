// The model types that the SDL may reference. Adding an entity to the schema means
// adding it here, so an object field cannot point at a type that is not registered.
import type { Conversation, Project, ProjectEgress, Task, TaskStatus } from "../types.ts";

/**
 * Model types the SDL may reference, keyed by GraphQL object name.
 *
 * @internal
 *
 * @remarks
 * `spec.ts` compares an object field's model type against these values at compile time. Adding
 * an entity to `entities.ts` without adding it here makes object fields that name it fail to
 * compile, so the registry and the SDL cannot drift.
 */
export interface EntityRegistry {
  readonly Project: Project;
  readonly Conversation: Conversation;
  readonly Task: Task;
}

/**
 * Enum unions the SDL may reference, keyed by GraphQL enum name.
 *
 * @internal
 *
 * @remarks
 * A model string maps to an enum only when its union is registered here; otherwise it maps to
 * `String` or `ID`.
 */
export interface EnumRegistry {
  readonly ProjectEgress: ProjectEgress;
  readonly TaskStatus: TaskStatus;
}
