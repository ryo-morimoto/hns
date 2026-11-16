import * as v from "valibot";
import {
  ConversationIdSchema,
  ProjectIdSchema,
  type Conversation,
  type Project,
  type ProjectId,
  type Task,
  type TaskStatus as TaskStatusModel,
} from "@hns/core";
import { fromGlobalId, toGlobalId } from "@hns/core/graphql";
import { fetchQuery } from "react-relay";
import type { Environment } from "relay-runtime";
import type { ProjectsQuery as ProjectsQueryType } from "../__generated__/ProjectsQuery.graphql";
import type {
  TaskStatus,
  WorkspaceQuery as WorkspaceQueryType,
} from "../__generated__/WorkspaceQuery.graphql";
import { ProjectsQuery } from "./Projects.ts";
import { WorkspaceQuery } from "./Workspace.ts";
import type { WorkspaceSource } from "./workspaceSource.ts";

/** One project's conversations and tasks, as one Relay read returns them. */
interface WorkspaceData {
  readonly conversations: readonly Conversation[];
  readonly tasks: readonly Task[];
}

/** Decode a global id the server sent, refusing a type the selection did not ask for. */
function rawId(globalId: string, type: string): string {
  const decoded = fromGlobalId(globalId);
  if (!decoded.ok || decoded.value.type !== type) {
    throw new Error("the server returned a malformed " + type + " id");
  }
  return decoded.value.id;
}

/** The GraphQL enum name to the model's status. */
function taskStatusOf(value: TaskStatus): TaskStatusModel {
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
}

/** Fail loudly on a query failure instead of rendering an empty list. */
function failureOf(operation: string, code: string, message: string): never {
  throw new Error(operation + " failed: " + code + " (" + message + ")");
}

/**
 * A WorkspaceSource whose reads go through Relay.
 *
 * @param environment - The app's environment; the same store backs every read.
 * @returns The shell's read surface, backed by the two compiled queries.
 *
 * @remarks
 * The shell still consumes model types while selection moves into the components (0179); this
 * file is the bridge, and it disappears when the fragments own the reads. The conversations and
 * tasks of one project share one read, so the two hooks do not race two requests.
 */
export function createRelaySource(environment: Environment): WorkspaceSource {
  const reads = new Map<string, Promise<WorkspaceData>>();

  const readWorkspace = (projectId: ProjectId): Promise<WorkspaceData> => {
    const key = String(projectId);
    const cached = reads.get(key);
    if (cached !== undefined) return cached;
    const read = (async (): Promise<WorkspaceData> => {
      const data = await fetchQuery<WorkspaceQueryType>(
        environment,
        WorkspaceQuery,
        { projectId: toGlobalId("Project", projectId) },
        { fetchPolicy: "store-or-network" },
      ).toPromise();
      if (data === undefined) throw new Error("the workspace read returned no data");
      const conversations = data.conversations;
      if (conversations.__typename === "QueryFailure") {
        failureOf("conversations", conversations.code, conversations.message);
      }
      if (conversations.__typename !== "ConversationList") {
        throw new Error("conversations: the server returned an unknown member");
      }
      const tasks = data.tasks;
      if (tasks.__typename === "QueryFailure") {
        failureOf("tasks", tasks.code, tasks.message);
      }
      if (tasks.__typename !== "TaskList") {
        throw new Error("tasks: the server returned an unknown member");
      }
      return {
        conversations: conversations.conversations.map((view): Conversation => ({
          id: v.parse(ConversationIdSchema, rawId(view.id, "Conversation")),
          project_id: v.parse(ProjectIdSchema, rawId(view.projectId, "Project")),
          title: view.title,
          created_at: view.createdAt,
          updated_at: view.updatedAt ?? null,
          archived: view.isArchived,
          deleted_at: view.deletedAt ?? null,
        })),
        tasks: tasks.tasks.map((view): Task => ({
          id: rawId(view.id, "Task"),
          project_id: v.parse(ProjectIdSchema, rawId(view.projectId, "Project")),
          title: view.title,
          status: taskStatusOf(view.status),
          created_at: view.createdAt,
          updated_at: view.updatedAt,
        })),
      };
    })();
    reads.set(key, read);
    return read;
  };

  return {
    async listProjects() {
      const data = await fetchQuery<ProjectsQueryType>(
        environment,
        ProjectsQuery,
        {},
        {
          fetchPolicy: "store-or-network",
        },
      ).toPromise();
      if (data === undefined) throw new Error("the projects read returned no data");
      const union = data.projects;
      if (union.__typename === "QueryFailure") {
        failureOf("projects", union.code, union.message);
      }
      if (union.__typename !== "ProjectList") {
        throw new Error("projects: the server returned an unknown member");
      }
      return union.projects.map((view): Project => ({
        id: v.parse(ProjectIdSchema, rawId(view.id, "Project")),
        name: view.name,
        created_at: view.createdAt,
      }));
    },

    async listConversations(projectId) {
      return (await readWorkspace(projectId)).conversations;
    },

    async listTasks(projectId) {
      return (await readWorkspace(projectId)).tasks;
    },

    listRuns() {
      // Runs have no GraphQL projection yet (WorkflowRun is excluded); the section stays empty.
      return Promise.resolve([]);
    },
  };
}
