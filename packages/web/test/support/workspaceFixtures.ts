import {
  ConversationIdSchema,
  ProjectIdSchema,
  type Conversation,
  type Project,
  type Task,
} from "@hns/core";
import { fromGlobalId, toGlobalId } from "@hns/core/graphql";
import * as v from "valibot";
import type { GraphQLCall, Responder } from "./relay.ts";

const hns = v.parse(ProjectIdSchema, "project-hns");
const scratch = v.parse(ProjectIdSchema, "project-scratch");
const docs = v.parse(ProjectIdSchema, "project-docs");
const intent = v.parse(ConversationIdSchema, "conversation-intent");
const design = v.parse(ConversationIdSchema, "conversation-design");

const projects: readonly Project[] = [
  { id: hns, name: "hns", created_at: "2026-11-01T00:00:00.000Z" },
  { id: scratch, name: "scratch", created_at: "2026-11-06T00:00:00.000Z" },
  { id: docs, name: "docs", created_at: "2026-11-05T00:00:00.000Z" },
];

const conversations: readonly Conversation[] = [
  {
    id: intent,
    project_id: hns,
    title: "Web の土台",
    created_at: "2026-11-07T00:00:00.000Z",
    updated_at: "2026-11-07T00:10:00.000Z",
    archived: false,
    deleted_at: null,
  },
  {
    id: design,
    project_id: hns,
    title: "デザインシステムのレビュー",
    created_at: "2026-11-07T00:20:00.000Z",
    updated_at: null,
    archived: false,
    deleted_at: null,
  },
];

const tasks: readonly Task[] = [
  {
    id: "task-1",
    project_id: hns,
    title: "Web の土台",
    status: "doing",
    created_at: "2026-11-07T00:00:00.000Z",
    updated_at: "2026-11-07T00:00:00.000Z",
  },
];

const projectPayload = (project: Project) => ({
  id: toGlobalId("Project", project.id),
  name: project.name,
  createdAt: project.created_at,
});

const taskPayload = (task: Task) => ({
  id: toGlobalId("Task", task.id),
  title: task.title,
  status: task.status.toUpperCase(),
});

/** The project a workspace call names, decoded from its global id. */
function projectOf(call: GraphQLCall): string | undefined {
  const parsed = v.safeParse(v.string(), call.variables["projectId"]);
  if (!parsed.success) return undefined;
  const decoded = fromGlobalId(parsed.output);
  return decoded.ok ? decoded.value.id : undefined;
}

/** The fixture responder the shell tests use; it answers the two compiled operations. */
export const workspaceFixture: Responder = (call) => {
  if (call.operation === "ShellProjectsQuery") {
    return { projects: { __typename: "ProjectList", projects: projects.map(projectPayload) } };
  }
  if (call.operation === "ShellWorkspaceQuery") {
    if (call.variables["hasProject"] !== true) return {};
    const projectId = projectOf(call);
    if (projectId === undefined) return undefined;
    return {
      conversations: {
        __typename: "ConversationList",
        conversations: conversations.flatMap((conversation) =>
          conversation.project_id === projectId
            ? [
                {
                  id: toGlobalId("Conversation", conversation.id),
                  projectId: toGlobalId("Project", conversation.project_id),
                  title: conversation.title,
                },
              ]
            : [],
        ),
      },
      tasks: {
        __typename: "TaskList",
        tasks: tasks.flatMap((task) => (task.project_id === projectId ? [taskPayload(task)] : [])),
      },
    };
  }
  return undefined;
};
