import type {
  CapabilityAtom,
  PolicyDiff,
  PolicyDocument,
  PolicyProposal,
  PolicyProposalStatus,
  PolicyRevision,
} from "@hns/core/capability";
import { POLICY_PROPOSAL_STATUSES } from "@hns/core/capability";
import { toGlobalId } from "@hns/core/graphql";

/**
 * A policy document as the GraphQL face serves and accepts it (`docs/capability.md` §10).
 *
 * @remarks
 * The face is deliberately **flatter** than the stored document: Phase 1 exposes roots, whether
 * `bash` is permitted, and whether the egress envelope names a network, because those are the
 * atoms a human decides on. `CapabilityScope` / `HostPort` are not published.
 *
 * `readRoots` / `writeRoots` are the enabled tool's roots; a tool the document does not govern
 * (absent, or disabled) has no roots, so the round trip through {@link policyDocumentOf} can only
 * express a document whose tools are all enabled-or-absent. A stored document that disables a tool
 * or carries egress hosts does not round-trip, and {@link policyDocumentView} is the read half for
 * it (`readRoots: []`) — Phase 1 stores neither through this face.
 */
export interface PolicyDocumentView {
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  /** Whether the policy permits `bash` on the workspace's sandbox. */
  readonly bash: boolean;
  /** Whether the egress envelope names (`true`) or blocks (`false`) a network. */
  readonly network: boolean;
}

/** The `PolicyRevision` GraphQL shape. */
export interface PolicyRevisionView {
  readonly id: string;
  /** The workspace as a global id, so the field is addressable from the revision too. */
  readonly workspaceId: string;
  readonly revision: number;
  readonly hash: string;
  readonly active: boolean;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly document: PolicyDocumentView;
}

/** The `PolicyProposal` GraphQL shape, with the diff a human reads. */
export interface PolicyProposalView {
  readonly id: string;
  readonly baseRevision: number;
  readonly reviewToken: string;
  readonly status: PolicyProposalStatus;
  readonly requestedBy: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly candidate: PolicyDocumentView;
  readonly diff: PolicyDiffView;
}

/** One comparable capability atom. */
export interface PolicyDiffAtomView {
  readonly atomKind: CapabilityAtom["kind"];
  readonly value: string;
}

/** How a candidate differs from its base. */
export interface PolicyDiffView {
  readonly kind: PolicyDiff["kind"];
  readonly added: readonly PolicyDiffAtomView[];
  readonly removed: readonly PolicyDiffAtomView[];
}

/** The roots a read or write tool permits, or an empty list when the tool is not governed. */
function rootsOf(document: PolicyDocument, tool: "read_file" | "write_file"): readonly string[] {
  const policy = document.tools[tool];
  if (policy === undefined || !policy.enabled) return [];
  const scope = policy.scope;
  return scope.kind === "read" || scope.kind === "write" ? scope.roots : [];
}

/** Map a stored document to the face's flatter shape. */
export function policyDocumentView(document: PolicyDocument): PolicyDocumentView {
  const bash = document.tools.bash;
  return {
    readRoots: rootsOf(document, "read_file"),
    writeRoots: rootsOf(document, "write_file"),
    bash: bash !== undefined && bash.enabled,
    network: document.egress.enabled,
  };
}

/** Map every comparable atom, keeping its kind and value as strings (no JSON scalar). */
function atomsOf(atoms: readonly CapabilityAtom[]): readonly PolicyDiffAtomView[] {
  return atoms.map((atom) => ({ atomKind: atom.kind, value: atom.value }));
}

/** Map a diff to the face's shape. */
export function policyDiffView(diff: PolicyDiff): PolicyDiffView {
  return { kind: diff.kind, added: atomsOf(diff.added), removed: atomsOf(diff.removed) };
}

/**
 * Map a revision to the face's shape.
 *
 * @param revision - The stored revision.
 * @param active - The workspace's active revision number, which decides `active`.
 */
export function policyRevisionView(revision: PolicyRevision, active: number): PolicyRevisionView {
  return {
    id: toGlobalId("PolicyRevision", revision.workspaceId + "/" + String(revision.revision)),
    workspaceId: toGlobalId("Project", revision.workspaceId),
    revision: revision.revision,
    hash: revision.hash,
    active: revision.revision === active,
    createdAt: revision.createdAt,
    createdBy: revision.createdBy,
    document: policyDocumentView(revision.document),
  };
}

/**
 * Map a proposal and its diff to the face's shape.
 *
 * @param proposal - The stored proposal.
 * @param diff - The diff against the base revision the proposal names.
 *
 * @remarks
 * `id` crosses the boundary as a `PolicyProposal` global id, like every other id on this face: the
 * client hands it back to `decidePolicy`, and an id that is not one is `invalid_request`, so the
 * store's own id stays inside the face.
 */
export function policyProposalView(proposal: PolicyProposal, diff: PolicyDiff): PolicyProposalView {
  return {
    id: toGlobalId("PolicyProposal", proposal.id),
    baseRevision: proposal.baseRevision,
    reviewToken: proposal.reviewToken,
    status: proposal.status,
    requestedBy: proposal.requestedBy,
    reason: proposal.reason,
    createdAt: proposal.createdAt,
    decidedBy: proposal.decidedBy ?? null,
    decidedAt: proposal.decidedAt ?? null,
    decisionReason: proposal.decisionReason ?? null,
    candidate: policyDocumentView(proposal.candidate),
    diff: policyDiffView(diff),
  };
}

/** Whether a string is one of the proposal statuses (the enum's input spellings are mapped first). */
export function isPolicyProposalStatus(value: string): value is PolicyProposalStatus {
  return POLICY_PROPOSAL_STATUSES.some((status) => status === value);
}
