import {
  GraphQLBoolean,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from "graphql";
import type {
  PolicyDocument,
  PolicyProposalStatus,
  PolicyTools,
  ToolPolicy,
} from "@hns/core/capability";
import type { ProjectId } from "@hns/core";
import * as v from "valibot";
import { ProjectIdSchema } from "@hns/core";
import { fromGlobalId } from "@hns/core/graphql";
import { normalizePath } from "@hns/core/capability";
import type { PolicyDocumentView } from "./views.ts";
import { isPolicyProposalStatus } from "./views.ts";

/**
 * The grant ceiling every proposed tool policy carries; see `policy/revisions.ts`.
 *
 * @remarks
 * The envelope's defaults are the server's, not a proposal's choice: a proposal changes what a tool
 * may reach, not how many times it may be called. The face repeats them because a document must
 * carry them; the store validates them again.
 */
const GRANT_TTL_SECONDS = 60;
const MAX_CALLS_PER_GRANT = 10;

/** The maximum roots a proposal may name for one tool. */
const MAX_ROOTS = 64;
/** The inclusive maximum length of one root, in UTF-16 code units. */
const MAX_ROOT_LENGTH = 1_024;
/** The maximum length of a proposal or decision reason. */
const MAX_REASON_LENGTH = 1_000;

/** `Mutation.proposePolicy`'s input, as a GraphQL input object. */
export const PolicyProposalInputType = new GraphQLInputObjectType({
  name: "PolicyProposalInput",
  fields: {
    workspaceId: { type: new GraphQLNonNull(GraphQLID) },
    /**
     * The roots the policy's `read_file` permits.
     *
     * @remarks
     * A root is a **workspace-relative POSIX path**, where `"."` is the workspace root — the same
     * vocabulary `CapabilityScope` uses, and **not** `Project.workspaceRoot`: that field names the
     * directory below the machine's ROOT, while a policy root is resolved from the workspace the
     * tool call runs in. No leading `/`, no "..", segment, no backslash, no NUL, no glob.
     *
     * An empty list means **unchanged**: the candidate keeps the active revision's roots for this
     * tool, so a client that only changes `writeRoots` sends `readRoots: []`.
     */
    readRoots: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    /**
     * The roots the policy's `write_file` permits.
     *
     * @remarks
     * The same vocabulary and the same "empty means unchanged" rule as {@link readRoots}. A tool the
     * active revision does not govern and this proposal does not name stays ungoverned.
     */
    writeRoots: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    /**
     * Whether the policy permits `bash`.
     *
     * @remarks
     * This is a **permission**, not a sandbox: whether the workspace has a sandbox is the server's
     * fact, and a proposal only says whether the policy allows a command to run on it. The
     * document it builds is always `{kind: "exec", network: "none", writable: false}`, so a proposal
     * can turn `bash` on or off but cannot widen its envelope.
     */
    bash: { type: new GraphQLNonNull(GraphQLBoolean) },
    /** Whether the egress envelope names a network; `true` is `unsupported` in Phase 1. */
    network: { type: new GraphQLNonNull(GraphQLBoolean) },
    reason: { type: new GraphQLNonNull(GraphQLString) },
  },
});

/** `Mutation.decidePolicy`'s input, as a GraphQL input object. */
export const DecidePolicyInputType = new GraphQLInputObjectType({
  name: "DecidePolicyInput",
  fields: {
    proposalId: { type: new GraphQLNonNull(GraphQLID) },
    /** The token the human read; a token that no longer recomputes is `approval_stale`. */
    reviewToken: { type: new GraphQLNonNull(GraphQLString) },
    approve: { type: new GraphQLNonNull(GraphQLBoolean) },
    reason: { type: new GraphQLNonNull(GraphQLString) },
  },
});

/** A decoded `PolicyProposalInput`. */
export interface ProposePolicyInput {
  readonly workspaceId: ProjectId;
  readonly document: PolicyDocument;
  readonly reason: string;
}

/** A decoded `DecidePolicyInput`. */
export interface DecidePolicyInput {
  readonly proposalId: string;
  readonly reviewToken: string;
  readonly approve: boolean;
  readonly reason: string;
}

/** A decode that either produced the value or the message to refuse it with. */
type Decoded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

/**
 * A document decode: a shape Phase 1 cannot honour is `unsupported`, and a malformed one is
 * `invalid_request`.
 */
type DocumentDecoded =
  | { readonly ok: true; readonly value: PolicyDocument }
  | {
      readonly ok: false;
      readonly kind: "invalid_request" | "unsupported";
      readonly message: string;
    };

/** A `proposePolicy` decode: the refusal also names the policy code it answers with. */
type DecodedPropose =
  | { readonly ok: true; readonly value: ProposePolicyInput }
  | {
      readonly ok: false;
      readonly message: string;
      /** `unsupported` for a shape Phase 1 cannot honour; `invalid_request` for a malformed input. */
      readonly code: "invalid_request" | "unsupported";
    };

/** A malformed argument. */
function invalid<T>(message: string): Decoded<T> {
  return { ok: false, message };
}

/**
 * Decode a `workspaceId` global id.
 *
 * @internal
 * @param value - The argument or the input's field.
 * @returns The raw project id, or the refusal message.
 *
 * @remarks
 * `invalid_request` covers the two shapes an id can get wrong (not a global id, or a global id of
 * another type); an id of the right shape that names no project is the resolver's `not_found`.
 */
export function workspaceIdOf(value: string | null | undefined): Decoded<ProjectId> {
  if (value === null || value === undefined || value.length === 0) {
    return invalid("workspaceId is required.");
  }
  const decoded = fromGlobalId(value);
  if (!decoded.ok) return invalid("workspaceId must be a global id.");
  if (decoded.value.type !== "Project") return invalid("workspaceId must name a Project.");
  if (decoded.value.id.length === 0) return invalid("workspaceId must name a Project.");
  return { ok: true, value: v.parse(ProjectIdSchema, decoded.value.id) };
}

/**
 * Decode the `status` argument of `policyProposals`.
 *
 * @internal
 * @param value - The argument, already mapped from its enum spelling by GraphQL.
 * @returns The status, `undefined` for every status, or the refusal message.
 */
/**
 * Read the `status` argument.
 *
 * @param value - The argument as GraphQL hands it over (an optional enum value, or absent).
 * @returns The status, `undefined` for every status, or the refusal.
 *
 * @remarks
 * GraphQL's own coercion is the parse: the argument's type is a `GraphQLEnumType`, so the executor
 * has already refused an unknown spelling and passes one of the contract's three values. The
 * parameter is typed as that closed union, and the check is only for a resolver called directly
 * (a test) with a value the enum never produced.
 */
export function statusOf(
  value: PolicyProposalStatus | null | undefined,
): Decoded<PolicyProposalStatus | undefined> {
  if (value === null || value === undefined) return { ok: true, value: undefined };
  if (!isPolicyProposalStatus(value)) return invalid("status is not a proposal status.");
  return { ok: true, value };
}

/**
 * Decode one root list.
 *
 * @internal
 * @remarks
 * A root is checked for **size** here only: it must be 1..{@link MAX_ROOT_LENGTH} characters, and the
 * list at most {@link MAX_ROOTS} entries. Its **meaning** is the atom algebra's: whether the contract
 * can compare it (a glob, an absolute path, a "..", segment, a NUL) is {@link comparableRoots}' answer,
 * and that answer is `unsupported`, not `invalid_request` — a `{b,c}` root is a well-formed string this
 * contract refuses, not a malformed request.
 */
function rootsOf(value: readonly string[], field: string): Decoded<readonly string[]> {
  if (value.length > MAX_ROOTS) {
    return invalid(field + " must have at most " + String(MAX_ROOTS) + " entries.");
  }
  for (const root of value) {
    if (root.length === 0 || root.length > MAX_ROOT_LENGTH) {
      return invalid(field + " entries must be 1-" + String(MAX_ROOT_LENGTH) + " characters.");
    }
  }
  return { ok: true, value };
}

/** A root the atom algebra cannot compare; the refusal code is the policy face's, not an input error. */
type Uncomparable =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "invalid_request" | "unsupported";
      readonly message: string;
    };

/**
 * Refuse a root the atom algebra could not compare.
 *
 * @internal
 * @param roots - The decoded root lists.
 * @returns `unsupported` with the first unusable root, or ok.
 *
 * @remarks
 * The roots are checked here, before the service is asked to compare anything, so a proposal the
 * contract cannot decide is refused as a `proposePolicy` refusal rather than stored as a pending
 * proposal no approval could ever accept (the service refuses it too; this is the face's own early
 * answer, and it is what makes the answer the caller sees `unsupported` rather than a guess).
 */
function comparableRoots(roots: readonly string[]): Uncomparable {
  for (const root of roots) {
    const normalized = normalizePath(root);
    if (normalized.kind !== "path") {
      return { ok: false, code: "unsupported", message: normalized.reason };
    }
  }
  return { ok: true };
}

/**
 * Build the stored document a proposal asks for, from the base it is built on.
 *
 * @internal
 * @param input - The decoded input.
 * @param base - The active revision's document, which supplies every atom the input does not name.
 * @returns The document, or `unsupported` because Phase 1 issues no grant that names a network.
 *
 * @remarks
 * **`[]` means "unchanged"**, not "the tool is ungoverned": a root list that names no root takes the
 * base document's roots for that tool, and the `bash` flag takes the base's `bash` permission. A UI
 * therefore has a way to say "change nothing here", and the whole document can equal the base —
 * which the service answers with a `proposal` whose `diff.kind` is `equal`, not with `unsupported`.
 * Phase 1 approves nothing automatically, so an equal proposal is valid and changes nothing active
 * when approved.
 *
 * The input names only four atoms, so a proposal can add or remove roots and turn `bash` on or off
 * over an **already-present** scope; it cannot widen a `bash` envelope (`network: true` is
 * `unsupported`, because no Phase 1 grant enforces a proxy and egress stays disabled), and it
 * cannot change a grant ceiling — those are the server's envelope, not a proposal's choice. That is
 * the contract's choice (§10), not an accident of this build.
 *
 * A tool the base does not govern and the input does not name stays ungoverned; a tool the base
 * governs and the input empties is removed, which the diff sees as `narrowing`.
 */
export function documentOf(input: PolicyDocumentView, base: PolicyDocument): DocumentDecoded {
  if (input.network) {
    return { ok: false, kind: "unsupported", message: "Phase 1 issues no grant over a network." };
  }
  const readRoots =
    input.readRoots.length === 0 ? rootsOfDocument(base, "read_file") : input.readRoots;
  const writeRoots =
    input.writeRoots.length === 0 ? rootsOfDocument(base, "write_file") : input.writeRoots;
  const bash = input.bash || base.tools.bash !== undefined;
  // Each tool is absent-or-present, decided by its own condition; a tool the input and the base
  // both leave unset is absent, which is what "not governed" means.
  const readFile =
    readRoots.length > 0 ? { read_file: toolPolicy({ kind: "read", roots: [...readRoots] }) } : {};
  const writeFile =
    writeRoots.length > 0
      ? { write_file: toolPolicy({ kind: "write", roots: [...writeRoots] }) }
      : {};
  const bashTool = bash
    ? { bash: toolPolicy({ kind: "exec", network: "none", writable: false }) }
    : {};
  const tools: PolicyTools = { ...readFile, ...writeFile, ...bashTool };
  return { ok: true, value: { v: 1, tools, egress: { enabled: false, hosts: [] } } };
}

/**
 * A tool policy with the envelope's grant ceiling.
 *
 * @internal
 * @remarks
 * A proposal changes what a tool may reach, not how many times it may be called, so the ceiling is
 * the server's two constants rather than a field the input could set.
 */
function toolPolicy(scope: ToolPolicy["scope"]): ToolPolicy {
  return {
    enabled: true,
    scope,
    grantTtlSeconds: GRANT_TTL_SECONDS,
    maxCallsPerGrant: MAX_CALLS_PER_GRANT,
  };
}

/**
 * The roots a stored document governs one tool with, or none when the tool is not governed.
 *
 * @internal
 * @param document - The base revision's document.
 * @param tool - The tool to read.
 * @returns The scope's roots; a tool that is absent, disabled, or not a read/write scope has none.
 */
function rootsOfDocument(
  document: PolicyDocument,
  tool: "read_file" | "write_file",
): readonly string[] {
  const policy = document.tools[tool];
  if (policy === undefined || !policy.enabled) return [];
  return policy.scope.kind === "read" || policy.scope.kind === "write" ? policy.scope.roots : [];
}

/**
 * Decode `Mutation.proposePolicy`'s input.
 *
 * @param input - The GraphQL input object, whose fields GraphQL has already type-checked.
 * @param base - The active revision's document; `[]` in the input means "keep the base's".
 * @returns The workspace, the document, and the reason, or the refusal.
 */
export function proposeInputOf(
  input: {
    readonly workspaceId: string;
    readonly readRoots: readonly string[];
    readonly writeRoots: readonly string[];
    readonly bash: boolean;
    readonly network: boolean;
    readonly reason: string;
  },
  base: PolicyDocument,
): DecodedPropose {
  const workspaceId = workspaceIdOf(input.workspaceId);
  if (!workspaceId.ok) return { ok: false, message: workspaceId.message, code: "invalid_request" };
  const readRoots = rootsOf(input.readRoots, "readRoots");
  if (!readRoots.ok) return { ok: false, message: readRoots.message, code: "invalid_request" };
  const writeRoots = rootsOf(input.writeRoots, "writeRoots");
  if (!writeRoots.ok) return { ok: false, message: writeRoots.message, code: "invalid_request" };
  const reason = reasonOf(input.reason);
  if (!reason.ok) return { ok: false, message: reason.message, code: "invalid_request" };
  const comparable = comparableRoots([...readRoots.value, ...writeRoots.value]);
  if (!comparable.ok) return { ok: false, message: comparable.message, code: comparable.code };
  const document = documentOf(
    {
      readRoots: readRoots.value,
      writeRoots: writeRoots.value,
      bash: input.bash,
      network: input.network,
    },
    base,
  );
  if (!document.ok) {
    return { ok: false, message: document.message, code: document.kind };
  }
  return {
    ok: true,
    value: {
      workspaceId: workspaceId.value,
      document: document.value,
      reason: reason.value,
    },
  };
}

/**
 * Decode `Mutation.decidePolicy`'s input.
 *
 * @param input - The GraphQL input object.
 * @returns The proposal id, the token, the decision, and the reason, or the refusal.
 */
export function decideInputOf(input: {
  readonly proposalId: string;
  readonly reviewToken: string;
  readonly approve: boolean;
  readonly reason: string;
}): Decoded<DecidePolicyInput> {
  const decoded = fromGlobalId(input.proposalId);
  if (!decoded.ok) return invalid("proposalId must be a global id.");
  if (decoded.value.type !== "PolicyProposal") {
    return invalid("proposalId must name a PolicyProposal.");
  }
  if (decoded.value.id.length === 0) return invalid("proposalId must name a PolicyProposal.");
  if (input.reviewToken.length === 0) return invalid("reviewToken is required.");
  const reason = reasonOf(input.reason);
  if (!reason.ok) return invalid(reason.message);
  return {
    ok: true,
    value: {
      proposalId: decoded.value.id,
      reviewToken: input.reviewToken,
      approve: input.approve,
      reason: reason.value,
    },
  };
}

/** A non-empty reason within the length bound. */
function reasonOf(value: string): Decoded<string> {
  const reason = value.trim();
  if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
    return invalid("reason must be 1-" + String(MAX_REASON_LENGTH) + " characters.");
  }
  return { ok: true, value: reason };
}
