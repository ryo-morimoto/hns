/* oxlint-disable anti-slop/no-runtime-typeof --
   A parsed document is still narrowed by the shape it claims to be: the typeof checks here confirm that
   claim, and anything else is unsupported. */
import { normalizePath } from "./paths.ts";
import type {
  CapabilityAtom,
  PolicyDiff,
  PolicyDocument,
  PolicyProposal,
  PolicyRevision,
} from "./types.ts";

/**
 * The policy algebra: the capability atoms a document allows, and how a candidate differs from its
 * base.
 *
 * @remarks
 * An **atom** is one thing a policy allows: a readable root, a writable root, an exec envelope
 * (`network=none`, `network=proxy`, `writable`), or an egress `host:port`. The diff is the set
 * difference over atoms, because a human approves the things that change, not the bytes.
 * Comparison is over the **string**, not over containment: `src` and `src/a` are different atoms, so
 * adding a child of an existing root is an expansion (`mixed`) and a human sees it
 * (`docs/capability.md` §6). Only the run-time allow check uses `isUnder`.
 *
 * A document whose form this module cannot compare — a glob, a path that does not normalize, a
 * tool with no policy, an egress host entry this contract does not know — has **no atoms**, and
 * `diffPolicy` answers `unsupported`: an expansion must never be hidden as `narrowing` or `equal`.
 *
 * An **unknown tool** does not reach this module: `PolicyDocumentSchema` is a strict object whose
 * `tools` names exactly `read_file`, `write_file`, and `bash`, so a document naming any other tool
 * is refused at the boundary before an atom is computed. `unsupported` here is the answer for a
 * tool or scope this contract knows but cannot compare, not for one it has never heard of.
 */

const TOOL_FIELDS = ["read_file", "write_file", "bash"] as const;

type ToolField = (typeof TOOL_FIELDS)[number];

function atomsOfRoots(kind: "read" | "write", roots: readonly string[]): CapabilityAtom[] | string {
  const atoms: CapabilityAtom[] = [];
  for (const root of roots) {
    const normalized = normalizePath(root);
    if (normalized.kind === "unsupported") {
      return "a " + kind + " root is " + normalized.reason;
    }
    atoms.push({ kind, value: normalized.value });
  }
  return atoms;
}

/**
 * The atoms one policy document allows.
 *
 * @param document - The policy document.
 * @returns The atoms, sorted (so a reader and a diff are stable), or the reason this contract cannot
 * compare the document.
 */
export function capabilityAtoms(document: PolicyDocument): CapabilityAtom[] | string {
  const atoms: CapabilityAtom[] = [];
  for (const tool of TOOL_FIELDS) {
    const policy: PolicyDocument["tools"][ToolField] = document.tools[tool];
    if (policy === undefined) continue;
    // A disabled tool allows nothing, whatever scope it names.
    if (!policy.enabled) continue;
    const scope = policy.scope;
    switch (scope.kind) {
      case "read":
      case "write": {
        const roots = atomsOfRoots(scope.kind, scope.roots);
        if (typeof roots === "string") return roots;
        atoms.push(...roots);
        break;
      }
      case "exec": {
        atoms.push({
          kind: "exec",
          value: scope.network === "proxy" ? "network=proxy" : "network=none",
        });
        if (scope.writable) atoms.push({ kind: "exec", value: "writable" });
        break;
      }
      case "exact":
        // An exact call is one call, not a capability set: it is not an atom a diff can compare.
        return "an exact scope is not a capability atom";
    }
  }
  if (document.egress.enabled) {
    for (const host of document.egress.hosts) {
      if (host.host === "" || host.host.includes("/")) return "a malformed egress host";
      atoms.push({ kind: "egress", value: host.host + ":" + String(host.port) });
    }
  }
  return sortAtoms(atoms);
}

function atomKey(atom: CapabilityAtom): string {
  return atom.kind + "\0" + atom.value;
}

function sortAtoms(atoms: readonly CapabilityAtom[]): CapabilityAtom[] {
  const unique = new Map<string, CapabilityAtom>();
  for (const atom of atoms) unique.set(atomKey(atom), atom);
  return [...unique.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, atom]) => atom);
}

/**
 * How a candidate differs from its base.
 *
 * @param base - The active revision's document.
 * @param candidate - The proposed document.
 * @returns `equal` when the atom sets are the same; `expansion` when the candidate only adds;
 * `narrowing` when it only removes; `mixed` when it does both; `unsupported` when either document has
 * no comparable atoms, with empty `added` / `removed` (the caller refuses rather than approves).
 */
export function diffPolicy(base: PolicyDocument, candidate: PolicyDocument): PolicyDiff {
  const baseAtoms = capabilityAtoms(base);
  const candidateAtoms = capabilityAtoms(candidate);
  if (typeof baseAtoms === "string" || typeof candidateAtoms === "string") {
    return { kind: "unsupported", added: [], removed: [] };
  }
  const before = new Map(baseAtoms.map((atom) => [atomKey(atom), atom]));
  const after = new Map(candidateAtoms.map((atom) => [atomKey(atom), atom]));
  const added = candidateAtoms.filter((atom) => !before.has(atomKey(atom)));
  const removed = baseAtoms.filter((atom) => !after.has(atomKey(atom)));
  if (added.length === 0 && removed.length === 0) return { kind: "equal", added, removed };
  if (removed.length === 0) return { kind: "expansion", added, removed };
  if (added.length === 0) return { kind: "narrowing", added, removed };
  return { kind: "mixed", added, removed };
}

/**
 * Whether a revision is the one a proposal was built on.
 *
 * @remarks
 * An approval is stale when the active revision moved (`revision` or `hash`) after the proposal was
 * made; it is also stale when the proposal itself is not pending. A stale approval is
 * `approval_stale`, never a retry against the newer revision.
 *
 * @param proposal - The proposal being decided.
 * @param active - The active revision, or `null` when the workspace has none.
 * @returns `true` when the proposal may still be decided.
 */
export function isProposalCurrent(
  proposal: Pick<PolicyProposal, "status" | "baseRevision" | "baseHash">,
  active: Pick<PolicyRevision, "revision" | "hash"> | null,
): boolean {
  return (
    proposal.status === "pending" &&
    active !== null &&
    active.revision === proposal.baseRevision &&
    active.hash === proposal.baseHash
  );
}
