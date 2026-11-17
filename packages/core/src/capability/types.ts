/* oxlint-disable anti-slop/no-unsafe-dictionary-type --
   A call's args and an audit event's decision are the contract's own untrusted payloads: the tool schema
   and the strict schemas in schemas.ts parse them at the boundary, so the contract names them as the
   values they are before parsing, not as a narrower type this module cannot know. */
import type { IsoTimestamp } from "../codecs.ts";

/**
 * The tool-call capability contract: what a tool is, what a call of it is, what grants allow a
 * call, and what a policy and its approval mean. The design record is
 * `docs/capability.md` §3–§4 (D091).
 *
 * @remarks
 * These types are the source of truth; the valibot schemas in {@link ./schemas.ts} are bound to
 * them and the hashes in {@link ./canonical.ts} are computed from them. Nothing here stores a key,
 * talks HTTP, or writes a database: the server issues grants, the machine verifies them, and this
 * module is the vocabulary both sides share.
 */

/** The tools a manifest, a call, or a grant may name. */
export const TOOL_IDS = ["read_file", "write_file", "bash"] as const;

/** One tool a manifest, a call, or a grant may name. */
export type ToolId = (typeof TOOL_IDS)[number];

/**
 * How much a tool can change.
 *
 * @remarks
 * `read` reads, `write` changes the workspace, and `exec` runs a process. The risk is part of the
 * manifest's contract, so changing it changes the manifest hash.
 */
export const TOOL_RISKS = ["read", "write", "exec"] as const;

/** How much a tool can change. */
export type ToolRisk = (typeof TOOL_RISKS)[number];

/** How much of a tool's output a call may return. */
export interface OutputLimits {
  readonly maxBytes: number;
  readonly maxLines: number;
}

/**
 * The contract of one tool version.
 *
 * @remarks
 * `manifestHash` = `sha256Hex(JCS(manifest))` is a hash of this **contract**, not of the code that
 * implements it (D091): the bytes compared at call time are the description the model saw, the
 * parameter descriptor it was given, and the limits it is held to. `version` is raised when the
 * behaviour changes; `descriptionHash` and `parametersHash` are `sha256Hex(JCS(...))` of the
 * canonical text and parameter descriptor.
 */
export interface ToolManifest {
  readonly v: 1;
  readonly toolId: ToolId;
  readonly version: string;
  readonly descriptionHash: string;
  readonly parametersHash: string;
  readonly risk: ToolRisk;
  readonly outputLimits: OutputLimits;
}

/**
 * One call of a tool.
 *
 * @remarks
 * `callId` is the durable id the agent gave the call (`tool:<ms>:<id>`), and `args` is the value
 * **after** the tool's own strict schema validated it: a call carries no `undefined`, no non-finite
 * number, and no key the tool does not declare. The call's identity is `callHash`
 * ({@link ./canonical.ts}), not the object.
 */
export interface ToolCall {
  readonly v: 1;
  readonly callId: string;
  readonly toolId: ToolId;
  readonly toolVersion: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * The bytes of one call, as hashes.
 *
 * @remarks
 * `argsHash` = `sha256Hex(JCS(args))` and `callHash` =
 * `sha256Hex(JCS({v: 1, callId, toolId, toolVersion, argsHash}))`. A machine recomputes both from
 * the operation it is about to run and refuses when either differs from the one it was authorized
 * with.
 */
export interface CallDigest {
  readonly argsHash: string;
  readonly callHash: string;
}

/** The roots a filesystem tool may touch, or `"."` for the workspace root. */
export interface ReadScope {
  readonly kind: "read";
  readonly roots: readonly string[];
}

/** The roots a writing tool may touch, or `"."` for the workspace root. */
export interface WriteScope {
  readonly kind: "write";
  readonly roots: readonly string[];
}

/** The envelope a process runs in. */
export interface ExecScope {
  readonly kind: "exec";
  readonly network: "none" | "proxy";
  readonly writable: boolean;
}

/** Exactly one call, by its `callHash`. */
export interface ExactScope {
  readonly kind: "exact";
  readonly callHash: string;
}

/** The most a grant allows a tool to do. */
export type CapabilityScope = ReadScope | WriteScope | ExecScope | ExactScope;

/** The scope kinds, closed. */
export const SCOPE_KINDS = ["read", "write", "exec", "exact"] as const;

/** One kind of {@link CapabilityScope}. */
export type ScopeKind = (typeof SCOPE_KINDS)[number];

/** The network an exec scope allows. */
export const EXEC_NETWORKS = ["none", "proxy"] as const;

/** The network an exec scope allows. */
export type ExecNetwork = (typeof EXEC_NETWORKS)[number];

/**
 * The signature algorithm of a grant.
 *
 * @remarks
 * Phase 1 signs with `Ed25519`. `ECDSA-P256` is in the contract so a verifier never has to widen a
 * union to accept one, but Phase 1 does not issue it. A verifier refuses a grant whose `alg` does
 * not match the key it was handed (`grant_algorithm_mismatch`).
 */
export const GRANT_ALGORITHMS = ["Ed25519", "ECDSA-P256"] as const;

/** The signature algorithm of a grant. */
export type GrantAlgorithm = (typeof GRANT_ALGORITHMS)[number];

/**
 * What a signed grant says.
 *
 * @remarks
 * The signature is over `JCS(payload)`, so every field below is authenticated. `epoch` is the
 * policy revision the grant was issued under; a machine refuses an epoch older than the newest one
 * it has seen. `maxCalls` and `maxBytes` bound what the grant may spend, and the counter is spent
 * by the machine outside this contract.
 */
export interface GrantPayload {
  readonly v: 1;
  readonly grantId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly machineId: string;
  readonly toolId: ToolId;
  readonly toolVersion: string;
  readonly manifestHash: string;
  readonly scope: CapabilityScope;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly epoch: number;
  readonly maxCalls: number;
  readonly maxBytes: number;
  readonly nonce: string;
  readonly alg: GrantAlgorithm;
  readonly keyId: string;
}

/**
 * A grant and the signature over its payload.
 *
 * @remarks
 * `signature` is the base64url (no padding) signature over the UTF-8 bytes of `canonicalize(payload)`.
 */
export interface SignedGrant {
  readonly payload: GrantPayload;
  readonly signature: string;
}

/** What the policy allows one tool to do. */
export interface ToolPolicy {
  readonly enabled: boolean;
  readonly scope: CapabilityScope;
  readonly grantTtlSeconds: number;
  readonly maxCallsPerGrant: number;
}

/** One host and port egress allows. */
export interface HostPort {
  readonly host: string;
  readonly port: number;
}

/** Egress, disabled by default. */
export interface EgressPolicy {
  readonly enabled: boolean;
  readonly hosts: readonly HostPort[];
}

/** A policy's tools. A tool with no entry is not governed by this revision. */
export interface PolicyTools {
  readonly read_file?: ToolPolicy;
  readonly write_file?: ToolPolicy;
  readonly bash?: ToolPolicy;
}

/**
 * One version of a workspace's policy.
 *
 * @remarks
 * `policyHash` = `sha256Hex(JCS(document))`. A revision is immutable; the active revision is a
 * separate pointer the server changes with compare-and-swap.
 */
export interface PolicyDocument {
  readonly v: 1;
  readonly tools: PolicyTools;
  readonly egress: EgressPolicy;
}

/** One immutable policy revision. */
export interface PolicyRevision {
  readonly workspaceId: string;
  readonly revision: number;
  readonly hash: string;
  readonly document: PolicyDocument;
  readonly createdAt: IsoTimestamp;
  readonly createdBy: string;
}

/** Where a proposal stands. */
export const POLICY_PROPOSAL_STATUSES = ["pending", "approved", "rejected"] as const;

/** Where a proposal stands. */
export type PolicyProposalStatus = (typeof POLICY_PROPOSAL_STATUSES)[number];

/**
 * A proposed policy, waiting for a human.
 *
 * @remarks
 * The proposal is bound to the revision it was built on (`baseRevision` / `baseHash`) and to the
 * exact candidate (`candidateHash`), and `reviewToken` binds all three to the credential of the
 * reader: an approval that recomputes a different token is `approval_stale`. The optional
 * `decided*` fields appear together once a human decided.
 */
export interface PolicyProposal {
  readonly id: string;
  readonly workspaceId: string;
  readonly baseRevision: number;
  readonly baseHash: string;
  readonly candidate: PolicyDocument;
  readonly candidateHash: string;
  readonly reviewToken: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly status: PolicyProposalStatus;
  readonly createdAt: IsoTimestamp;
  readonly decidedBy?: string | undefined;
  readonly decidedAt?: IsoTimestamp | undefined;
  readonly decisionReason?: string | undefined;
}

/** The exec atoms a policy can grant. */
export const EXEC_ATOMS = ["network=none", "network=proxy", "writable"] as const;

/** The exec atoms a policy can grant. */
export type ExecAtom = (typeof EXEC_ATOMS)[number];

/** One thing a policy allows, as an atom a set difference can compare. */
export type CapabilityAtom =
  | { readonly kind: "read"; readonly value: string }
  | { readonly kind: "write"; readonly value: string }
  | { readonly kind: "exec"; readonly value: ExecAtom }
  | { readonly kind: "egress"; readonly value: string };

/** The atom kinds, closed. */
export const ATOM_KINDS = ["read", "write", "exec", "egress"] as const;

/** How a candidate differs from its base. */
export const POLICY_DIFF_KINDS = [
  "equal",
  "narrowing",
  "expansion",
  "mixed",
  "unsupported",
] as const;

/** How a candidate differs from its base. `unsupported` is a diff that could not be computed. */
export type PolicyDiffKind = (typeof POLICY_DIFF_KINDS)[number];

/** The atoms a candidate adds and removes against its base. */
export interface PolicyDiff {
  readonly kind: PolicyDiffKind;
  readonly added: readonly CapabilityAtom[];
  readonly removed: readonly CapabilityAtom[];
}

/**
 * Why a call was refused.
 *
 * @remarks
 * A denial is a value, never an exception. {@link DENIAL_RETRY} says whether the caller may retry,
 * which is the only thing a model is told besides the message.
 */
export const DENIAL_CODES = [
  "policy_denied",
  "tool_disabled",
  "scope_exceeded",
  "manifest_mismatch",
  "grant_invalid",
  "grant_expired",
  "grant_algorithm_mismatch",
  "grant_replayed",
  "counter_exhausted",
  "epoch_stale",
  "path_outside_root",
  "command_not_allowed",
  "egress_denied",
  "approval_stale",
  "unsupported",
] as const;

/** Why a call was refused. */
export type DenialCode = (typeof DENIAL_CODES)[number];

/**
 * Whether a caller may retry after a denial.
 *
 * @remarks
 * `retry` means the same call may be sent again once the state it names has moved (a fresh grant,
 * a new epoch, a new proposal); every other value means the call cannot succeed by repeating it.
 * The table is the contract; a consumer switches on {@link DenialCode} and reads this, so a new code
 * cannot be added without deciding its retry.
 */
export const DENIAL_RETRY = {
  policy_denied: "propose",
  tool_disabled: "never",
  scope_exceeded: "never",
  manifest_mismatch: "never",
  grant_invalid: "never",
  grant_expired: "retry",
  grant_algorithm_mismatch: "never",
  grant_replayed: "never",
  counter_exhausted: "never",
  epoch_stale: "retry",
  path_outside_root: "never",
  command_not_allowed: "never",
  egress_denied: "never",
  approval_stale: "retry",
  unsupported: "never",
} as const satisfies Readonly<Record<DenialCode, unknown>>;

/** How a caller may act on a denial. */
export type DenialRetry = (typeof DENIAL_RETRY)[DenialCode];

/** The call may run. */
export interface AllowDecision {
  readonly outcome: "allow";
  readonly policyRevision: number;
  readonly policyHash: string;
  readonly grantId?: string | undefined;
}

/** The call may not run. */
export interface DenyDecision {
  readonly outcome: "deny";
  readonly code: DenialCode;
  readonly message: string;
  readonly policyRevision?: number | undefined;
  readonly policyHash?: string | undefined;
}

/** The result of authorizing one call. */
export type PolicyDecision = AllowDecision | DenyDecision;

/**
 * What every audit event shares.
 *
 * @remarks
 * **A call that never became one has no hashes.** `callHash` and `argsHash` are present for a call
 * that was admitted — the arguments parsed, the path was inside the root, the call had a canonical
 * form — and absent for a refused one: `path_outside_root`, `unsupported` (an unknown key, a
 * `timeout` in another unit, ill-typed arguments), or arguments pi-durable refused before the tool
 * ran. Those rows still name the tool, its manifest, and the denial, because that is what an auditor
 * needs; they cannot name the call, because there was no call to name and `argsHash` would hash
 * arguments the tool never accepted (`docs/capability.md` §3, `docs/capability.md` §8). An empty
 * string is **not** the absence: the member is left out, so a consumer reads "did a call exist"
 * from the key's presence.
 *
 * The two hashes are optional together or present together; a schema cannot say that with two
 * `optional` members, so the producers (`@hns/agent`'s `AuditRow`) write both or neither and the
 * audit's verifier (`@hns/server`) records which it saw.
 */
export interface AuditEventBase {
  readonly v: 1;
  readonly eventId: string;
  readonly at: IsoTimestamp;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly callId: string;
  /** `callHash` of the call; absent when the call was refused (see the type's remarks). */
  readonly callHash?: string | undefined;
  /** `argsHash` of the call; absent when the call was refused (see the type's remarks). */
  readonly argsHash?: string | undefined;
  readonly toolId: ToolId;
  readonly toolVersion: string;
  readonly manifestHash: string;
  readonly grantId?: string | undefined;
  readonly prevHash: string | null;
  readonly hash: string;
}

/** A call about to run. */
export interface ToolCallAuditEvent extends AuditEventBase {
  readonly event: "tool.call";
}

/** A call that ran, with the decision it ran under. */
export interface ToolResultAuditEvent extends AuditEventBase {
  readonly event: "tool.result";
  readonly decision: PolicyDecision;
  readonly durationMs: number;
}

/** One append-only audit entry. */
export type AuditEvent = ToolCallAuditEvent | ToolResultAuditEvent;
