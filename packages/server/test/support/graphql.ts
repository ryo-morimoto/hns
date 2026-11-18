import * as v from "valibot";
import {
  ConversationIdSchema,
  ProjectIdSchema,
  type Conversation,
  type Project,
  type Trail,
  type TrailChange,
} from "@hns/core";

const AT = "2026-01-01T00:00:00.000Z";

/** A project with stable timestamps; the root defaults to the machine ROOT. */
export function project(
  id: string,
  name: string = id,
  workspaceRoot = "",
  egress: Project["egress"] = "inherit",
): Project {
  return {
    id: v.parse(ProjectIdSchema, id),
    name,
    workspace_root: workspaceRoot,
    agent_cwd: workspaceRoot,
    egress,
    created_at: AT,
  };
}

/** A conversation in `projectId`. */
export function conversation(
  id: string,
  projectId: string,
  title: string = id,
  updated: string | null = null,
): Conversation {
  return {
    id: v.parse(ConversationIdSchema, id),
    project_id: v.parse(ProjectIdSchema, projectId),
    title,
    created_at: AT,
    updated_at: updated,
    archived: false,
    deleted_at: null,
  };
}

/** A Trail in `projectId`, in the state the store creates one. */
export function trail(id: string, projectId: string, title: string = id): Trail {
  return {
    id,
    project_id: v.parse(ProjectIdSchema, projectId),
    title,
    description: "",
    acceptance: "",
    kind: "feature",
    state: "draft",
    priority: "normal",
    created_by: "owner",
    created_at: AT,
    updated_at: AT,
  };
}

/** A Change of `trailId`, with a base and a head that differ (T-2). */
export function trailChange(id: string, trailId: string): TrailChange {
  return {
    id,
    trail_id: trailId,
    workspace_id: "project-hns",
    repo_id: null,
    base_commit: "1".repeat(40),
    head_commit: "2".repeat(40),
    run_id: null,
    state: "open",
    created_at: AT,
    updated_at: AT,
  };
}
