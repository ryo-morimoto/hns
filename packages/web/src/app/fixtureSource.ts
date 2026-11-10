import {
  ConversationIdSchema,
  ProjectIdSchema,
  type Conversation,
  type Project,
  type Task,
  type WorkflowRun,
} from "@hns/core";
import * as v from "valibot";
import type { WorkspaceSource } from "./workspaceSource.ts";

// Model fixtures for the shell. There is no server yet; 0178 replaces this with Relay reads.

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

const runs: readonly WorkflowRun[] = [
  {
    id: "run-1",
    workflow_id: "workflow-release",
    version: 1,
    status: "done",
    input: "リリース準備",
    output: null,
    created_at: "2026-11-06T22:00:00.000Z",
    finished_at: "2026-11-06T22:04:00.000Z",
  },
  {
    id: "run-2",
    workflow_id: "workflow-review",
    version: 3,
    status: "running",
    input: "0101 のレビュー",
    output: null,
    created_at: "2026-11-07T00:30:00.000Z",
    finished_at: null,
  },
];

export function createFixtureSource(): WorkspaceSource {
  return {
    listProjects: () => Promise.resolve(projects),
    listConversations: (projectId) =>
      Promise.resolve(conversations.filter((item) => item.project_id === projectId)),
    listTasks: (projectId) =>
      Promise.resolve(tasks.filter((item) => item.project_id === projectId)),
    listRuns: () => Promise.resolve(runs),
  };
}
