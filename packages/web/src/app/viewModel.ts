import * as v from "valibot";
import {
  ConversationIdSchema,
  ProjectIdSchema,
  type ConversationId,
  type ProjectId,
  type TrailState,
} from "@hns/core";
import { fromGlobalId } from "@hns/core/graphql";

/** What the sidebar and top bar render for a project. */
export interface ProjectLink {
  readonly id: ProjectId;
  readonly name: string;
  /** The project's directory below the machine ROOT; empty is the ROOT itself. */
  readonly workspace_root: string;
  /** The directory the agent starts in; equal to `workspace_root` for now. */
  readonly agent_cwd: string;
}

/** What the sidebar renders for a conversation. */
export interface ConversationLink {
  readonly id: ConversationId;
  readonly project_id: ProjectId;
  readonly title: string;
}

/**
 * What the sidebar renders for a Trail: the intent, its project, and its state.
 *
 * @remarks
 * The Sidebar groups by state (`trailGroupOf`); a Trail's own state is the only status there is
 * (D104), so there is no column to read in addition to it.
 */
export interface TrailLink {
  readonly id: string;
  readonly project_id: ProjectId;
  readonly title: string;
  readonly state: TrailState;
}

/** Decode a global id the server sent, refusing a type the selection did not ask for. */
function rawId(globalId: string, type: string): string {
  const decoded = fromGlobalId(globalId);
  if (!decoded.ok || decoded.value.type !== type) {
    throw new Error("the server returned a malformed " + type + " id");
  }
  return decoded.value.id;
}

/**
 * The GraphQL enum names `TrailState` defines, plus the forward-compatibility marker.
 *
 * @remarks
 * Written out rather than derived, because the generated document's type is the one the schema
 * printed: a value the enum does not carry cannot arrive, and one this build does not know is the
 * marker Relay adds for a newer server.
 */
type TrailStateName =
  | "DRAFT"
  | "ACTIVE"
  | "IN_REVIEW"
  | "MERGED"
  | "OBSERVING"
  | "CLOSED"
  | "ABANDONED"
  | "%future added value";

/** The GraphQL enum name to the model's state; the union is closed. */
function trailStateOf(value: TrailStateName): TrailState {
  switch (value) {
    case "DRAFT":
      return "draft";
    case "ACTIVE":
      return "active";
    case "IN_REVIEW":
      return "in_review";
    case "MERGED":
      return "merged";
    case "OBSERVING":
      return "observing";
    case "CLOSED":
      return "closed";
    case "ABANDONED":
      return "abandoned";
    case "%future added value":
      throw new Error("the server sent a trail state this build does not know");
    default: {
      // A value outside the generated union still reaches here at runtime; fail loudly.
      const unknown: never = value;
      throw new Error("the server sent an unknown trail state: " + String(unknown));
    }
  }
}

/**
 * The four lists a Sidebar shows (D104: no board, no columns).
 *
 * @remarks
 * The principle is Needs you -> Running -> Completed, in the Trail vocabulary:
 *
 * - `needs-you`: a Trail waiting for a person (`in_review`).
 * - `active`: work under way (`draft`, `active`).
 * - `observing`: merged and watched (`merged`, `observing`).
 * - `closed`: ended (`closed`, `abandoned`).
 */
export type TrailGroup = "needs-you" | "active" | "observing" | "closed";

/** The lists in the order the Sidebar renders them. */
export const TRAIL_GROUPS = ["needs-you", "active", "observing", "closed"] as const;

/** The heading each list carries. */
export const TRAIL_GROUP_LABELS: Readonly<Record<TrailGroup, string>> = {
  "needs-you": "Needs you",
  active: "Active",
  observing: "Observing",
  closed: "Closed",
};

/**
 * Which list a Trail belongs to: the state to the group, exhaustively.
 *
 * @param state - The Trail's model state.
 * @returns The one list it appears in.
 *
 * @remarks
 * The `switch` is exhaustive and ends in `never`: a state added to the model's `TrailState` fails
 * to compile here until it says where a reader finds it, so a Trail cannot silently belong to no
 * list.
 */
export function trailGroupOf(state: TrailState): TrailGroup {
  switch (state) {
    case "in_review":
      return "needs-you";
    case "draft":
    case "active":
      return "active";
    case "merged":
    case "observing":
      return "observing";
    case "closed":
    case "abandoned":
      return "closed";
    default: {
      const unknown: never = state;
      throw new Error("a trail state with no list: " + String(unknown));
    }
  }
}

/**
 * Group Trails into the Sidebar's lists, keeping the server's newest-first order in each.
 *
 * @param trails - The Trails to show, newest first.
 * @returns One entry per list in {@link TRAIL_GROUPS} order; a list with no Trail is empty.
 *
 * @remarks
 * A group with no Trail still appears, so the Sidebar's shape does not change with the data: a
 * reader learns "nothing is waiting for you" by reading the list, not by its absence.
 */
export function trailGroupsOf(
  trails: readonly TrailLink[],
): readonly { readonly group: TrailGroup; readonly trails: readonly TrailLink[] }[] {
  return TRAIL_GROUPS.map((group) => ({
    group,
    trails: trails.filter((trail) => trailGroupOf(trail.state) === group),
  }));
}

/**
 * Map a project payload to what the chrome renders.
 *
 * @remarks
 * The GraphQL boundary carries global ids; the routes and links use the model's raw ids, so the
 * decode happens here once instead of at every comparison.
 */
export function projectLinkOf(view: {
  readonly id: string;
  readonly name: string;
  readonly workspaceRoot: string;
  readonly agentCwd: string;
}): ProjectLink {
  return {
    id: v.parse(ProjectIdSchema, rawId(view.id, "Project")),
    name: view.name,
    workspace_root: view.workspaceRoot,
    agent_cwd: view.agentCwd,
  };
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

/** Map a Trail payload to what the sidebar renders. */
export function trailLinkOf(view: {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly state: TrailStateName;
}): TrailLink {
  return {
    id: rawId(view.id, "Trail"),
    project_id: v.parse(ProjectIdSchema, rawId(view.projectId, "Project")),
    title: view.title,
    state: trailStateOf(view.state),
  };
}
