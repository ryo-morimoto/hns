import * as v from "valibot";
import {
  ConversationIdSchema,
  ProjectIdSchema,
  type ConversationId,
  type ProjectId,
  type TaskStatus,
} from "@hns/core";
import { fromGlobalId } from "@hns/core/graphql";

/** What the sidebar and top bar render for a project. */
export interface ProjectLink {
  readonly id: ProjectId;
  readonly name: string;
}

/** What the sidebar renders for a conversation. */
export interface ConversationLink {
  readonly id: ConversationId;
  readonly project_id: ProjectId;
  readonly title: string;
}

/** What the sidebar renders for a task. */
export interface TaskLink {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
}

/** Decode a global id the server sent, refusing a type the selection did not ask for. */
function rawId(globalId: string, type: string): string {
  const decoded = fromGlobalId(globalId);
  if (!decoded.ok || decoded.value.type !== type) {
    throw new Error("the server returned a malformed " + type + " id");
  }
  return decoded.value.id;
}

/** The GraphQL enum names the schema defines, plus the forward-compatibility marker. */
type TaskStatusName = "TODO" | "DOING" | "DONE" | "BLOCKED" | "%future added value";

/** The GraphQL enum name to the model's status; the union is closed. */
function taskStatusOf(value: TaskStatusName): TaskStatus {
  switch (value) {
    case "TODO":
      return "todo";
    case "DOING":
      return "doing";
    case "DONE":
      return "done";
    case "BLOCKED":
      return "blocked";
    case "%future added value":
      throw new Error("the server sent a task status this build does not know");
  }
  // A value outside the generated union still reaches here at runtime; fail loudly.
  const unknown: never = value;
  throw new Error("the server sent an unknown task status: " + String(unknown));
}

/**
 * Map a project payload to what the chrome renders.
 *
 * @remarks
 * The GraphQL boundary carries global ids; the routes and links use the model's raw ids, so the
 * decode happens here once instead of at every comparison.
 */
export function projectLinkOf(view: { readonly id: string; readonly name: string }): ProjectLink {
  return { id: v.parse(ProjectIdSchema, rawId(view.id, "Project")), name: view.name };
}

/** Map a conversation payload to what the sidebar renders. */
export function conversationLinkOf(view: {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
}): ConversationLink {
  return {
    id: v.parse(ConversationIdSchema, rawId(view.id, "Conversation")),
    project_id: v.parse(ProjectIdSchema, rawId(view.projectId, "Project")),
    title: view.title,
  };
}

/** Map a task payload to what the sidebar renders. */
export function taskLinkOf(view: {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatusName;
}): TaskLink {
  return {
    id: rawId(view.id, "Task"),
    title: view.title,
    status: taskStatusOf(view.status),
  };
}
