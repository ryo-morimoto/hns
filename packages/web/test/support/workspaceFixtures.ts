import {
  ConversationIdSchema,
  ProjectIdSchema,
  type Conversation,
  type Project,
  type JsonValue,
  type Trail,
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
  {
    id: hns,
    name: "hns",
    workspace_root: "",
    agent_cwd: "",
    egress: "inherit",
    created_at: "2026-11-01T00:00:00.000Z",
  },
  {
    id: scratch,
    name: "scratch",
    workspace_root: "projects/scratch",
    agent_cwd: "projects/scratch",
    egress: "inherit",
    created_at: "2026-11-06T00:00:00.000Z",
  },
  {
    id: docs,
    name: "docs",
    workspace_root: "projects/docs",
    agent_cwd: "projects/docs",
    egress: "deny",
    created_at: "2026-11-05T00:00:00.000Z",
  },
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

/**
 * The Trails the shell's fixtures list.
 *
 * @remarks
 * One per Sidebar group, so a shell test sees all four lists populated: a review waits for a
 * person, a draft is under way, a merged Trail is observed, and a closed one ended.
 */
const trails: readonly Trail[] = [
  {
    id: "trail-review",
    project_id: hns,
    title: "レビューを待つ",
    description: "",
    acceptance: "",
    kind: "feature",
    state: "in_review",
    priority: "high",
    created_by: "owner",
    created_at: "2026-11-07T00:30:00.000Z",
    updated_at: "2026-11-07T00:30:00.000Z",
  },
  {
    id: "trail-draft",
    project_id: hns,
    title: "Web の土台",
    description: "",
    acceptance: "",
    kind: "feature",
    state: "draft",
    priority: "normal",
    created_by: "owner",
    created_at: "2026-11-07T00:00:00.000Z",
    updated_at: "2026-11-07T00:00:00.000Z",
  },
  {
    id: "trail-observing",
    project_id: hns,
    title: "観測中の変更",
    description: "",
    acceptance: "",
    kind: "fix",
    state: "observing",
    priority: "normal",
    created_by: "owner",
    created_at: "2026-11-06T00:00:00.000Z",
    updated_at: "2026-11-06T00:00:00.000Z",
  },
  {
    id: "trail-closed",
    project_id: hns,
    title: "終わった作業",
    description: "",
    acceptance: "",
    kind: "chore",
    state: "closed",
    priority: "low",
    created_by: "owner",
    created_at: "2026-11-05T00:00:00.000Z",
    updated_at: "2026-11-05T00:00:00.000Z",
  },
];

const projectPayload = (project: Project) => ({
  id: toGlobalId("Project", project.id),
  name: project.name,
  workspaceRoot: project.workspace_root,
  agentCwd: project.agent_cwd,
  createdAt: project.created_at,
});

const trailPayload = (trail: Trail) => ({
  __typename: "Trail",
  id: toGlobalId("Trail", trail.id),
  projectId: toGlobalId("Project", trail.project_id),
  title: trail.title,
  state: trail.state.toUpperCase(),
});

/** The project a workspace call names, decoded from its global id. */
function projectOf(call: GraphQLCall): string | undefined {
  const parsed = v.safeParse(v.string(), call.variables["projectId"]);
  if (!parsed.success) return undefined;
  const decoded = fromGlobalId(parsed.output);
  return decoded.ok ? decoded.value.id : undefined;
}

/**
 * One fixture conversation by its raw id.
 *
 * @param id - The id a route or URL names.
 * @returns The row, or undefined when the fixture has no such conversation.
 *
 * @remarks
 * The shell tests answer `/api/conversations/:id/state` from this, so a conversation route in
 * any shell test opens the same conversation the sidebar lists.
 */
export function conversationFixture(id: string): Conversation | undefined {
  return conversations.find((conversation) => conversation.id === id);
}

/**
 * The policy answer every shell test's fixture gives.
 *
 * @remarks
 * The policy screen mounts under the shell, and the shell's fixtures answer its read with an empty
 * policy: one active revision and no proposal. The documents are the screen's own wire shapes
 * (the four axes the contract publishes), so a shell test proves the route, not the policy.
 *
 * @param workspaceId - The `Project` global id the read named.
 * @returns The `policyRevisions` and `policyProposals` members.
 */
function policyFixture(workspaceId: string) {
  return {
    policyRevisions: {
      __typename: "PolicyRevisionList",
      revisions: [
        {
          __typename: "PolicyRevision",
          id: toGlobalId("PolicyRevision", workspaceId + "/1"),
          revision: 1,
          hash: "a".repeat(64),
          active: true,
          createdAt: "2026-11-01T00:00:00.000Z",
          createdBy: "system",
          document: {
            __typename: "PolicyDocument",
            readRoots: ["."],
            writeRoots: ["."],
            bash: false,
            network: false,
          },
        },
      ],
    },
    policyProposals: { __typename: "PolicyProposalList", proposals: [] },
  } satisfies JsonValue;
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
      trails: {
        __typename: "TrailList",
        trails: trails.flatMap((trail) =>
          trail.project_id === projectId ? [trailPayload(trail)] : [],
        ),
      },
    };
  }
  if (call.operation === "PolicyScreenQuery") {
    const workspaceId = v.safeParse(v.string(), call.variables["workspaceId"]);
    if (!workspaceId.success) return undefined;
    return policyFixture(workspaceId.output);
  }
  return undefined;
};
