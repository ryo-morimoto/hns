import type { PolicyScreenQuery } from "../../__generated__/PolicyScreenQuery.graphql";
import type { PolicyScreenDecideMutation } from "../../__generated__/PolicyScreenDecideMutation.graphql";
import type { PolicyScreenProposeMutation } from "../../__generated__/PolicyScreenProposeMutation.graphql";

/**
 * The screen's vocabulary: how a policy code, a proposal status, and a diff are said in the UI.
 *
 * @remarks
 * Pure functions over the generated shapes. A member the union does not name is never answered by
 * this face (the resolver returns one of its own members, and a `__typename` outside the schema is
 * a server defect), so `%other` is reported as one rather than rendered as a blank panel.
 */

/** The `policyRevisions` member a successful list read answers with. */
type PolicyRevisionListRecord = Extract<
  PolicyScreenQuery["response"]["policyRevisions"],
  { readonly __typename: "PolicyRevisionList" }
>;
/** One revision of the workspace's policy, with its document. */
export type PolicyRevisionRecord = PolicyRevisionListRecord["revisions"][number];
/** The `policyProposals` member a successful list read answers with. */
type PolicyProposalListRecord = Extract<
  PolicyScreenQuery["response"]["policyProposals"],
  { readonly __typename: "PolicyProposalList" }
>;
/** One proposal, with its candidate and its diff. */
export type PolicyProposalRecord = PolicyProposalListRecord["proposals"][number];
/** One policy document as the face publishes it: the four axes a person decides on. */
export type PolicyDocumentRecord = PolicyRevisionRecord["document"];

/** How a diff kind reads on screen. */
export interface PolicyDiffLabel {
  readonly label: string;
  readonly tone: "ok" | "warn" | "danger";
}

/** How one capability atom reads on screen. */
export interface PolicyAtomLabel {
  /** The tool the atom belongs to: `read_file`, `write_file`, `bash`, `network`. */
  readonly tool: string;
  /** The value in that tool's terms. */
  readonly value: string;
}

/** A reason field's usable text. */
export interface PolicyReason {
  /** The trimmed text the input carries. */
  readonly text: string;
  /** Whether it is 1–1,000 characters. */
  readonly ok: boolean;
}
/** Where a proposal stands, as the enum's runtime value. */
export type PolicyProposalStatus = PolicyProposalRecord["status"];
/** How a candidate differs from its base. */
export type PolicyDiffKind = PolicyProposalRecord["diff"]["kind"];
/** One side of a diff. */
export type PolicyAtomRecord = PolicyProposalRecord["diff"]["added"][number];

/**
 * The active revision, or null when the read named none.
 *
 * @param revisions - The workspace's revisions, oldest first.
 * @returns The revision flagged active, or null.
 *
 * @remarks
 * The face reads through the `ensure`, so a workspace that exists answers at least revision 1.
 * A list with no active flag is a server answer this reader does not describe — a defect, not a
 * workspace without a policy — and the screen says so as an **empty state** (`role="status"`)
 * with the read offered again, never as an alarm: an alarm is for a read that was refused.
 */
export function activeRevisionOf(
  revisions: readonly PolicyRevisionRecord[],
): PolicyRevisionRecord | null {
  return revisions.find((revision) => revision.active) ?? null;
}

/** The proposals a human has not decided, newest first as the server sent them. */
export function pendingProposalsOf(
  proposals: readonly PolicyProposalRecord[],
): readonly PolicyProposalRecord[] {
  return proposals.filter((proposal) => proposal.status === "PENDING");
}

/** The proposals a human already decided, newest first. */
export function decidedProposalsOf(
  proposals: readonly PolicyProposalRecord[],
): readonly PolicyProposalRecord[] {
  return proposals.filter((proposal) => proposal.status !== "PENDING");
}

/**
 * How a diff kind is labelled.
 *
 * @param kind - The GraphQL enum's runtime value.
 * @returns The label and the badge tone.
 *
 * @remarks
 * Expansion can grant what the policy did not, so it warns; narrowing is a normal change;
 * `mixed` warns for the same reason as expansion; `unsupported` is a diff that could not be
 * computed, which no person should approve blind, so it is the danger tone.
 */
export function diffKindLabel(kind: PolicyDiffKind): PolicyDiffLabel {
  switch (kind) {
    case "EQUAL":
      return { label: "変更なし", tone: "ok" };
    case "NARROWING":
      return { label: "狭める", tone: "ok" };
    case "EXPANSION":
      return { label: "広げる", tone: "warn" };
    case "MIXED":
      return { label: "広げる・狭める", tone: "warn" };
    case "UNSUPPORTED":
      return { label: "比較できない", tone: "danger" };
    default:
      return unknownEnum(kind, "diff kind");
  }
}

/** What a proposal's status says. */
export function proposalStatusLabel(status: PolicyProposalStatus): string {
  switch (status) {
    case "PENDING":
      return "承認待ち";
    case "APPROVED":
      return "承認済み";
    case "REJECTED":
      return "却下";
    default:
      return unknownEnum(status, "proposal status");
  }
}

/** A value the generated enum does not know; the type's own future value, said as an error. */
function unknownEnum(value: string, what: string): never {
  throw new Error("unknown " + what + ": " + value);
}

/**
 * How one capability atom is said.
 *
 * @param atom - The atom's kind and value, which the face sends as strings.
 * @returns The tool the atom belongs to, and the value in that tool's terms.
 *
 * @remarks
 * The face sends the model's `CapabilityAtom` as two strings (no JSON scalar), so this is the
 * first place an unknown kind appears. It says the raw kind rather than guessing, and no atom is
 * dropped: an atom a person cannot read is still an atom a person must decide on.
 */
export function atomLabel(atom: PolicyAtomRecord): PolicyAtomLabel {
  switch (atom.atomKind) {
    case "read":
      return { tool: "read_file", value: atom.value };
    case "write":
      return { tool: "write_file", value: atom.value };
    case "exec":
      return { tool: "bash", value: execValueLabel(atom.value) };
    case "egress":
      return { tool: "network", value: atom.value };
    default:
      return { tool: atom.atomKind, value: atom.value };
  }
}

/** An exec atom's value, in a sentence a person reading a diff can act on. */
function execValueLabel(value: string): string {
  switch (value) {
    case "network=none":
      return "コマンド実行（ネットワークなし）";
    case "network=proxy":
      return "コマンド実行（プロキシ経由）";
    case "writable":
      return "ファイルの書き込み";
    default:
      return value;
  }
}

/** A root list, or the word for a tool the policy does not govern. */
export function rootsLabel(roots: readonly string[]): string {
  return roots.length === 0 ? "なし" : roots.join(", ");
}

/** Whether a document permits a thing. */
export function permissionLabel(allowed: boolean): string {
  return allowed ? "許可" : "拒否";
}

/** A reason field's trimmed text, and whether it is a usable reason (1–1,000 characters). */
export function reasonState(value: string): PolicyReason {
  const text = value.trim();
  return { text, ok: text.length > 0 && text.length <= 1000 };
}

/**
 * Split a roots field into the list a proposal input takes.
 *
 * @param value - What the person typed: roots separated by commas or newlines.
 * @returns The trimmed roots without empty entries; an empty field is `[]`, which is "unchanged".
 *
 * @remarks
 * **`[]` means "keep the active roots"** on the face, so an empty field does not ask for the
 * tool to be ungoverned; the field's hint says so. The roots are not normalised here: a glob or
 * an absolute path is the face's `unsupported` answer, and a second opinion here could disagree
 * with the service that stores the proposal.
 */
export function rootsOfField(value: string): readonly string[] {
  return value
    .split(/[\n,]/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * The screen's message for a `PolicyFailure` code.
 *
 * @param code - The code, as the enum's runtime value.
 * @returns The sentence the screen shows beside the server's own message.
 *
 * @remarks
 * The server's `message` is shown too: it names the root or the reason the face refused, and a
 * client that replaced it would drop the one detail a person needs to fix the input.
 */
export function policyCodeMessage(code: string): string {
  switch (code) {
    case "POLICY_DENIED":
      return "この操作は人間の principal だけが行えます。";
    case "APPROVAL_STALE":
      return "提案が古くなっています。一覧を読み直してください。";
    case "UNSUPPORTED":
      return "この変更は比較・適用できません。";
    case "NOT_FOUND":
      return "ワークスペースが見つかりません。";
    case "INVALID_REQUEST":
      return "入力が不正です。";
    default:
      return code;
  }
}

/** The outcome of one decision, as the screen says it. */
export type DecisionOutcome =
  | { readonly kind: "approved"; readonly revision: number; readonly proposalStale: boolean }
  | { readonly kind: "rejected" }
  | { readonly kind: "refused"; readonly code: string; readonly message: string };

/**
 * Read a `decidePolicy` answer.
 *
 * @param result - The mutation's `response`.
 * @returns The outcome the screen reports.
 *
 * @remarks
 * The union is branched on its member, never on a boolean: a refusal is a `PolicyFailure` and
 * never a payload with a flag, so `APPROVAL_STALE` cannot be read as a success. A payload with no
 * revision is a rejection (the face returns the new revision for an approval only).
 */
export function decideOutcomeOf(result: PolicyScreenDecideMutation["response"]): DecisionOutcome {
  const decided = result.decidePolicy;
  if (decided.__typename === "PolicyFailure") {
    return { kind: "refused", code: decided.code, message: decided.message };
  }
  if (decided.__typename !== "DecidePolicyPayload") {
    return { kind: "refused", code: "INVALID_RESPONSE", message: "決定の応答を読めません。" };
  }
  const revision = decided.revision?.revision;
  return revision === undefined
    ? { kind: "rejected" }
    : { kind: "approved", revision, proposalStale: decided.proposalStale };
}

/** Whether a proposal was recorded, and the refusal when it was not. */
export type ProposeOutcome =
  | { readonly kind: "proposed" }
  | { readonly kind: "refused"; readonly code: string; readonly message: string };

/**
 * Read a `proposePolicy` answer.
 *
 * @param result - The mutation's `response`.
 * @returns Whether the proposal was stored, or the refusal.
 *
 * @remarks
 * A proposal has no success payload the screen needs: what a person expects from it is the list,
 * which the screen reads again. The branch is still on the union member, so a refusal cannot be
 * read as a success, and an approval is never sent on the strength of the store alone.
 */
export function proposeOutcomeOf(result: PolicyScreenProposeMutation["response"]): ProposeOutcome {
  const proposed = result.proposePolicy;
  if (proposed.__typename === "PolicyFailure") {
    return { kind: "refused", code: proposed.code, message: proposed.message };
  }
  if (proposed.__typename !== "ProposePolicyPayload") {
    return { kind: "refused", code: "INVALID_RESPONSE", message: "提案の応答を読めません。" };
  }
  return { kind: "proposed" };
}
