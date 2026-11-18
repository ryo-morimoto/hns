import { toGlobalId } from "@hns/core/graphql";
import type {
  Conversation,
  Machine,
  Project,
  Trail,
  TrailChange,
  TrailDecision,
  TrailFinding,
  TrailGate,
  TrailSession,
} from "@hns/core";
import type { ReviewDiff } from "../review/service.ts";
import type { IndexStateRow } from "@hns/store";

/**
 * A `Project` as GraphQL serves it.
 *
 * @remarks
 * The mapping is explicit rather than a shared field resolver: the storage shape stays in the
 * server, and a model rename fails to compile here instead of silently returning `undefined`.
 */
export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly workspaceRoot: string;
  readonly agentCwd: string;
  readonly egress: Project["egress"];
  readonly createdAt: string;
}

/** The `Conversation` GraphQL shape. `archived` is exposed as `isArchived`. */
export interface ConversationView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly isArchived: boolean;
  readonly deletedAt: string | null;
}

/**
 * The `Trail` GraphQL shape (D104).
 *
 * @remarks
 * Every enum field stays a model value until the enum serializes it, so a value this build does
 * not know fails at the SDL boundary instead of being sent as a free string.
 *
 * The lists the `Trail` entity names (`changes`, `sessions`, `findings`, `decisions`, `gates`)
 * are **not** fields of this shape: they are resolved per Trail, from the id the row already
 * carries, so a list read of fifty Trails does not also read every attachment of each (0232 adds
 * the four that were missing beside `changes`; each hangs off the Trail's id the same way).
 *
 * The gates a reviewer reads now are **not** here either: they are computed from the head, the
 * findings, and the decisions (`Trail.gates`), because a stored answer would be an answer from
 * the moment it was written. `Trail.gateLine` is that computation as one line.
 */
export interface TrailView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly acceptance: string;
  readonly kind: Trail["kind"];
  readonly state: Trail["state"];
  readonly priority: Trail["priority"];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The `TrailChange` GraphQL shape: the `base..head` pair, as ids the store holds. */
export interface TrailChangeView {
  readonly id: string;
  readonly trailId: string;
  readonly workspaceId: string;
  readonly repoId: string | null;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly runId: string | null;
  readonly state: TrailChange["state"];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Map a project to its GraphQL shape.
 *
 * @remarks
 * Ids cross the GraphQL boundary as global ids: the same raw id under another type must not
 * collide in Relay's normalized store.
 */
export function projectView(project: Project): ProjectView {
  return {
    id: toGlobalId("Project", project.id),
    name: project.name,
    workspaceRoot: project.workspace_root,
    agentCwd: project.agent_cwd,
    egress: project.egress,
    createdAt: project.created_at,
  };
}

/** The `IndexState` GraphQL shape: the conversation index's backlog and last failure. */
export interface IndexStateView {
  readonly pending: number;
  readonly lastSyncedAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorAt: string | null;
}

/** Map the index state to its GraphQL shape. */
export function indexStateView(state: IndexStateRow): IndexStateView {
  return {
    pending: state.pending,
    lastSyncedAt: state.lastSyncedAt,
    lastErrorCode: state.lastErrorCode,
    lastErrorAt: state.lastErrorAt,
  };
}

/** Map a conversation to its GraphQL shape. */
export function conversationView(conversation: Conversation): ConversationView {
  return {
    id: toGlobalId("Conversation", conversation.id),
    projectId: toGlobalId("Project", conversation.project_id),
    title: conversation.title,
    createdAt: conversation.created_at,
    updatedAt: conversation.updated_at,
    isArchived: conversation.archived,
    deletedAt: conversation.deleted_at,
  };
}

/**
 * A `Machine` as GraphQL serves it (0148).
 *
 * @remarks
 * The device key is **not** here (NB2): a list is read by every session, and the key is the value
 * a verifier matches, so the list carries the `fingerprint` a person compares and nothing more.
 * The full public key leaves the registry only in `registerMachine`'s answer
 * ({@link MachineRegistrationView}). The control-plane key is never in either: it is the Worker's
 * secret, and `GET /api/machines/keys` is where its public half is served.
 */
export interface MachineView {
  readonly id: string;
  readonly name: string;
  readonly hostname: string;
  readonly fingerprint: string;
  readonly keyAlgorithm: Machine["keyAlgorithm"];
  readonly agentVersion: string;
  readonly lastSeen: number | null;
  readonly status: Machine["status"];
  /** Whether the **requesting** session enrolled this machine; never another operator's subject. */
  readonly isMine: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A `Machine` plus the public key, as `registerMachine` answers (NB2).
 *
 * @remarks
 * The operator who just pasted the key needs to see what was stored, so this one answer carries
 * it. It is the only place the key is returned; a list never does.
 */
export interface MachineRegistrationView extends MachineView {
  readonly publicKey: string;
}

/**
 * Map a machine to its GraphQL shape, without the device key and without anyone's subject.
 *
 * @param machine - The registry row.
 * @param viewer - The requesting session's subject, used only to answer `isMine`.
 * @returns The shape; `isMine` says whether this viewer enrolled it, and the owner's subject never
 * leaves the server.
 *
 * @remarks
 * `owner` is a session subject, which is a person's identity. A list is read by every session, so
 * publishing it would let any operator enumerate who enrolled every machine. `isMine` carries the
 * part a caller acts on: whether this is the machine they may reimage.
 */
export function machineView(machine: Machine, viewer: string): MachineView {
  return {
    id: toGlobalId("Machine", machine.id),
    name: machine.name,
    hostname: machine.hostname,
    fingerprint: machine.fingerprint,
    keyAlgorithm: machine.keyAlgorithm,
    agentVersion: machine.agentVersion,
    lastSeen: machine.lastSeen,
    status: machine.status,
    isMine: machine.owner === viewer,
    createdAt: machine.createdAt,
    updatedAt: machine.updatedAt,
  };
}

/** Map a machine to the registration answer: the GraphQL shape plus its public key. */
export function machineRegistrationView(machine: Machine, viewer: string): MachineRegistrationView {
  return { ...machineView(machine, viewer), publicKey: machine.publicKey };
}

/** Map a Trail to its GraphQL shape: the row itself, with its project as a global id. */
export function trailView(trail: Trail): TrailView {
  return {
    id: toGlobalId("Trail", trail.id),
    projectId: toGlobalId("Project", trail.project_id),
    title: trail.title,
    description: trail.description,
    acceptance: trail.acceptance,
    kind: trail.kind,
    state: trail.state,
    priority: trail.priority,
    createdBy: trail.created_by,
    createdAt: trail.created_at,
    updatedAt: trail.updated_at,
  };
}

/**
 * The `TrailSession` GraphQL shape: a link from a Trail to a conversation or a session.
 *
 * @remarks
 * `conversationId` is the one global id here (it names a `Conversation` row); `sessionId` and
 * `runId` carry the stored ids, like a Change's `workspaceId`.
 */
export interface TrailSessionView {
  readonly id: string;
  readonly trailId: string;
  readonly conversationId: string | null;
  readonly sessionId: string;
  readonly runId: string | null;
  readonly linkedAt: string;
}

/** Map a session link to its GraphQL shape. */
export function trailSessionView(link: TrailSession): TrailSessionView {
  return {
    id: toGlobalId("TrailSession", link.id),
    trailId: toGlobalId("Trail", link.trail_id),
    conversationId:
      link.conversation_id === null ? null : toGlobalId("Conversation", link.conversation_id),
    sessionId: link.session_id,
    runId: link.run_id,
    linkedAt: link.linked_at,
  };
}

/** The `TrailFinding` GraphQL shape: a point raised by a review, a test, or a person. */
export interface TrailFindingView {
  readonly id: string;
  readonly trailId: string;
  readonly changeId: string | null;
  readonly severity: TrailFinding["severity"];
  readonly source: TrailFinding["source"];
  readonly status: TrailFinding["status"];
  readonly file: string | null;
  readonly hunk: string | null;
  readonly summary: string;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
}

/** Map a finding to its GraphQL shape. */
export function trailFindingView(finding: TrailFinding): TrailFindingView {
  return {
    id: toGlobalId("TrailFinding", finding.id),
    trailId: toGlobalId("Trail", finding.trail_id),
    changeId: finding.change_id === null ? null : toGlobalId("TrailChange", finding.change_id),
    severity: finding.severity,
    source: finding.source,
    status: finding.status,
    file: finding.file,
    hunk: finding.hunk,
    summary: finding.summary,
    createdAt: finding.created_at,
    resolvedAt: finding.resolved_at,
    resolvedBy: finding.resolved_by,
  };
}

/** The `TrailDecision` GraphQL shape: an approval, a change request, or a rejection. */
export interface TrailDecisionView {
  readonly id: string;
  readonly trailId: string;
  readonly changeId: string | null;
  readonly actor: string;
  readonly action: TrailDecision["action"];
  /** The commit the decision was made against; an approval always names one (D104). */
  readonly headCommit: string | null;
  readonly note: string;
  readonly at: string;
}

/**
 * Map a decision to its GraphQL shape.
 *
 * @remarks
 * The global ids are the decision's and its Trail's. `changeId` is a `TrailChange` global id (the
 * row a selection can resolve through Relay's store) — `core`'s `TrailDecision` is one of the few
 * Trail types whose `changeId` the model spells `ID` and which names a Change the schema also
 * serves.
 */
export function trailDecisionView(decision: TrailDecision): TrailDecisionView {
  return {
    id: toGlobalId("TrailDecision", decision.id),
    trailId: toGlobalId("Trail", decision.trail_id),
    changeId: decision.change_id === null ? null : toGlobalId("TrailChange", decision.change_id),
    actor: decision.actor,
    action: decision.action,
    headCommit: decision.head_commit,
    note: decision.note,
    at: decision.at,
  };
}

/** The `TrailGate` GraphQL shape: what a gate said about a Trail or a Change at a moment. */
export interface TrailGateView {
  readonly id: string;
  readonly trailId: string;
  readonly changeId: string | null;
  readonly gate: TrailGate["gate"];
  readonly status: TrailGate["status"];
  readonly detail: string | null;
  readonly evaluatedAt: string;
}

/** Map a stored gate evaluation to its GraphQL shape. */
export function trailGateView(gate: TrailGate): TrailGateView {
  return {
    id: toGlobalId("TrailGate", gate.id),
    trailId: toGlobalId("Trail", gate.trail_id),
    changeId: gate.change_id === null ? null : toGlobalId("TrailChange", gate.change_id),
    gate: gate.gate,
    status: gate.status,
    detail: gate.detail,
    evaluatedAt: gate.evaluated_at,
  };
}

/**
 * A `ReviewDiff` as GraphQL serves it (C1): the files between two commits, as the checkpoint
 * diff reads them.
 *
 * @remarks
 * The shape is the diff engine's own (`server/src/review/service.ts`), narrowed to fields rather
 * than flattened: `added`/`removed` are totals a file line shows, and a binary file appears with
 * no hunks so "changed, not previewable" is said instead of being dropped.
 */
export interface ReviewDiffView {
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly added: number;
  readonly removed: number;
  readonly files: readonly ReviewFileView[];
}

/** One file of a `ReviewDiff`. */
export interface ReviewFileView {
  readonly path: string;
  readonly change: "added" | "deleted" | "modified";
  readonly added: number;
  readonly removed: number;
  /** Whether the file has hunks; false is a binary file or a submodule ("not previewable"). */
  readonly previewable: boolean;
  readonly hunks: readonly ReviewHunkView[];
}

/** One hunk of a file: where it starts on each side, and its lines. */
export interface ReviewHunkView {
  readonly baseStart: number;
  readonly headStart: number;
  readonly lines: readonly ReviewLineView[];
}

/** One line of a hunk: `CONTEXT`, `ADD`, or `DEL`, and the text without its terminator. */
export interface ReviewLineView {
  readonly kind: "context" | "add" | "del";
  readonly text: string;
}

/** Map the diff engine's answer to the GraphQL shape. */
export function reviewDiffView(
  diff: ReviewDiff,
): ReviewDiffView & { readonly __typename: "ReviewDiff" } {
  return {
    __typename: "ReviewDiff",
    baseCommit: diff.base.commit,
    headCommit: diff.head.commit,
    added: diff.added,
    removed: diff.removed,
    files: diff.files.map((file) => ({
      path: file.path,
      change: file.kind,
      added: file.added,
      removed: file.removed,
      previewable: file.hunks.length > 0,
      hunks: file.hunks.map((hunk) => ({
        baseStart: hunk.baseStart,
        headStart: hunk.headStart,
        lines: hunk.lines.map((line) => ({ kind: line.kind, text: line.text })),
      })),
    })),
  };
}

/** Map a Change to its GraphQL shape.
 *
 * @remarks
 * Only the Change's own id and its Trail are global ids. `workspaceId`, `repoId`, and `runId` are
 * spelled as the SDL spells `ID` because they name a row, but they carry the stored value: a
 * Change's `workspace_id` is the workspace id the run used (not a `Project` id), and wrapping it
 * as one would let Relay merge it with the Project of the same value.
 */
export function trailChangeView(change: TrailChange): TrailChangeView {
  return {
    id: toGlobalId("TrailChange", change.id),
    trailId: toGlobalId("Trail", change.trail_id),
    workspaceId: change.workspace_id,
    repoId: change.repo_id,
    baseCommit: change.base_commit,
    headCommit: change.head_commit,
    runId: change.run_id,
    state: change.state,
    createdAt: change.created_at,
    updatedAt: change.updated_at,
  };
}
