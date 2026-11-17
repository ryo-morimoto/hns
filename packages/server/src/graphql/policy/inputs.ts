import {
  GraphQLBoolean,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from "graphql";
import type { PolicyDocument, PolicyProposalStatus } from "@hns/core/capability";
import type { ProjectId } from "@hns/core";
import * as v from "valibot";
import { ProjectIdSchema } from "@hns/core";
import { fromGlobalId } from "@hns/core/graphql";
import { GLOB_CHARACTERS, normalizePath } from "@hns/core/capability";
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
/** The maximum length of one root. */
const MAX_ROOT_LENGTH = 1_024;
/** The maximum length of a proposal or decision reason. */
const MAX_REASON_LENGTH = 1_000;

/** `Mutation.proposePolicy`'s input, as a GraphQL input object. */
export const PolicyProposalInputType = new GraphQLInputObjectType({
  name: "PolicyProposalInput",
  fields: {
    workspaceId: { type: new GraphQLNonNull(GraphQLID) },
    /** The roots the policy's `read_file` permits; empty leaves the tool ungoverned. */
    readRoots: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    /** The roots the policy's `write_file` permits; empty leaves the tool ungoverned. */
    writeRoots: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    /**
     * Whether the policy permits `bash`.
     *
     * @remarks
     * This is a **permission**, not a sandbox: whether the workspace has a sandbox is the server's
     * fact (0226), and a proposal only says whether the policy allows a command to run on it. The
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
 * A root is checked for **shape** here only: it must be non-empty, at most {@link MAX_ROOT_LENGTH}
 * characters, and free of a NUL and a glob. Whether the algebra can compare it (an absolute path,
 * a `..` segment, a backslash) is the diff's answer, which the service reports as `unsupported`;
 * an empty list disables the tool rather than naming the root.
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
 * The characters that make a root a glob, as the contract spells them.
 *
 * @internal
 * @remarks
 * Re-exported from the contract (`@hns/core/capability`) rather than written here: a second copy
 * drifts, and a rule that recognized only `*` and `?` would let `a/{b,c}` through. The face does not
 * test these characters itself — {@link normalizePath} already refuses them — but the list is named
 * so a reader of this file can see that the rule is the contract's.
 */
export const ROOT_GLOB_CHARACTERS = GLOB_CHARACTERS;

/**
 * Build the stored document a proposal asks for.
 *
 * @internal
 * @param input - The decoded input.
 * @returns The document, or `unsupported` because Phase 1 issues no grant that names a network.
 *
 * @remarks
 * The shape is the baseline's, with only the atoms the input can name: the tools whose root list
 * is non-empty are enabled over exactly those roots, `bash` is `network: "none"`, not writable, and
 * egress is disabled. **`network: true` is accepted and refused with `unsupported`**: the contract
 * has no Phase 1 grant to enforce a proxy, so a policy that named one would widen what a stored
 * revision says without anything that honours it. The grant ceiling (`grantTtlSeconds`,
 * `maxCallsPerGrant`) is the server's envelope, not a proposal's choice.
 *
 * A root list of one element is the common case (`["."]`); a list of none leaves the tool
 * ungoverned, which the diff sees as removing that tool's atoms.
 *
 * **What a proposal can express.** The input has no `writable` and no grant ceiling, so a proposal
 * can only add or remove roots (and turn `bash` on or off over an already-present scope): it can
 * narrow, or expand along roots, but it cannot widen a `bash` envelope or grant egress. That is the
 * contract's choice (§10), not an accident of this build.
 */
export function documentOf(input: PolicyDocumentView): DocumentDecoded {
  if (input.network) {
    return { ok: false, kind: "unsupported", message: "Phase 1 issues no grant over a network." };
  }
  // The tools are absent-or-present, one statement at a time: `exactOptionalPropertyTypes` means a
  // present key cannot hold undefined, so an empty object spread would widen the type.
  const tools: Record<
    string,
    NonNullable<PolicyDocument["tools"][keyof PolicyDocument["tools"]]>
  > = {};
  if (input.readRoots.length > 0) {
    tools.read_file = {
      enabled: true,
      scope: { kind: "read", roots: [...input.readRoots] },
      grantTtlSeconds: GRANT_TTL_SECONDS,
      maxCallsPerGrant: MAX_CALLS_PER_GRANT,
    };
  }
  if (input.writeRoots.length > 0) {
    tools.write_file = {
      enabled: true,
      scope: { kind: "write", roots: [...input.writeRoots] },
      grantTtlSeconds: GRANT_TTL_SECONDS,
      maxCallsPerGrant: MAX_CALLS_PER_GRANT,
    };
  }
  if (input.bash) {
    tools.bash = {
      enabled: true,
      scope: { kind: "exec", network: "none", writable: false },
      grantTtlSeconds: GRANT_TTL_SECONDS,
      maxCallsPerGrant: MAX_CALLS_PER_GRANT,
    };
  }
  return { ok: true, value: { v: 1, tools, egress: { enabled: false, hosts: [] } } };
}

/**
 * Decode `Mutation.proposePolicy`'s input.
 *
 * @param input - The GraphQL input object, whose fields GraphQL has already type-checked.
 * @returns The workspace, the document, and the reason, or the refusal.
 */
export function proposeInputOf(input: {
  readonly workspaceId: string;
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  readonly bash: boolean;
  readonly network: boolean;
  readonly reason: string;
}): DecodedPropose {
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
  const document = documentOf({
    readRoots: readRoots.value,
    writeRoots: writeRoots.value,
    bash: input.bash,
    network: input.network,
  });
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
