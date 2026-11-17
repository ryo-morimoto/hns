import * as v from "valibot";
import { IsoTimestampSchema } from "../codecs.ts";
import {
  DENIAL_CODES,
  EXEC_ATOMS,
  EXEC_NETWORKS,
  GRANT_ALGORITHMS,
  POLICY_DIFF_KINDS,
  POLICY_PROPOSAL_STATUSES,
  TOOL_IDS,
  TOOL_RISKS,
} from "./types.ts";
import type {
  AuditEvent,
  CallDigest,
  CapabilityAtom,
  CapabilityScope,
  GrantPayload,
  PolicyDecision,
  PolicyDiff,
  PolicyDocument,
  PolicyProposal,
  PolicyRevision,
  SignedGrant,
  ToolCall,
  ToolManifest,
} from "./types.ts";

/** The exact tools object of a policy document. */
type PolicyTools = PolicyDocument["tools"];

/**
 * The valibot schemas of the capability contract.
 *
 * @remarks
 * Every schema is a `GenericSchema<unknown, T>` for the type it parses into: the type in
 * {@link ./types.ts} is the source of truth, and a schema that stops producing it stops compiling.
 * Every object schema is `strictObject`, so **an unknown key is a `ValiError`** as much as a wrong
 * type or a missing field is. Values are parsed at the boundary (a Worker RPC, an HTTP body, a
 * machine's request) before any hash or signature is computed over them.
 *
 * A hash is `[0-9a-f]{64}`: lowercase hex, which is what every `*Hash` in this module produces.
 */

const HASH = /^[0-9a-f]{64}$/;

/** A lowercase hex SHA-256. */
export const HashSchema: v.GenericSchema<unknown, string> = v.pipe(v.string(), v.regex(HASH));

/** A base64url signature, unpadded: ASCII word characters and `-` (no `+`, `/`, or `=`). */
export const Base64UrlSchema: v.GenericSchema<unknown, string> = v.pipe(
  v.string(),
  v.regex(/^[\w-]+$/u),
);

/** A non-negative safe integer. */
const CountSchema: v.GenericSchema<unknown, number> = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
);

/** A positive safe integer. */
const PositiveSchema: v.GenericSchema<unknown, number> = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
);

/** How much output a call may return. */
export const OutputLimitsSchema: v.GenericSchema<unknown, ToolManifest["outputLimits"]> =
  v.strictObject({ maxBytes: CountSchema, maxLines: CountSchema });

/** The contract of one tool version. */
export const ToolManifestSchema: v.GenericSchema<unknown, ToolManifest> = v.strictObject({
  v: v.literal(1),
  toolId: v.picklist(TOOL_IDS),
  version: v.pipe(v.string(), v.minLength(1)),
  descriptionHash: HashSchema,
  parametersHash: HashSchema,
  risk: v.picklist(TOOL_RISKS),
  outputLimits: OutputLimitsSchema,
});

/**
 * The arguments of a call: a plain object.
 *
 * @remarks
 * The keys and values are the tool's own strict schema's business; this schema only fixes that
 * `args` is an object and not `null`. A `ValiError` for a nested value is still the tool's (or
 * `authorizeCall`'s `unsupported`) to report, not this schema's.
 */
export const ToolArgsSchema: v.GenericSchema<unknown, ToolCall["args"]> = v.record(
  v.string(),
  v.unknown(),
);

/** One call of a tool. */
export const ToolCallSchema: v.GenericSchema<unknown, ToolCall> = v.strictObject({
  v: v.literal(1),
  callId: v.pipe(v.string(), v.minLength(1)),
  toolId: v.picklist(TOOL_IDS),
  toolVersion: v.pipe(v.string(), v.minLength(1)),
  args: ToolArgsSchema,
});

/** The bytes of one call, as two hashes. */
export const CallDigestSchema: v.GenericSchema<unknown, CallDigest> = v.strictObject({
  argsHash: HashSchema,
  callHash: HashSchema,
});

/** A path root: `"."` or a POSIX relative path. */
export const PathRootSchema: v.GenericSchema<unknown, string> = v.pipe(v.string(), v.minLength(1));

/** The most a grant allows a tool to do: `read`, `write`, `exec`, or `exact`. */
export const CapabilityScopeSchema: v.GenericSchema<unknown, CapabilityScope> = v.variant("kind", [
  v.strictObject({ kind: v.literal("read"), roots: v.array(PathRootSchema) }),
  v.strictObject({ kind: v.literal("write"), roots: v.array(PathRootSchema) }),
  v.strictObject({
    kind: v.literal("exec"),
    network: v.picklist(EXEC_NETWORKS),
    writable: v.boolean(),
  }),
  v.strictObject({ kind: v.literal("exact"), callHash: HashSchema }),
]);

/** What a signed grant says. */
export const GrantPayloadSchema: v.GenericSchema<unknown, GrantPayload> = v.strictObject({
  v: v.literal(1),
  grantId: v.pipe(v.string(), v.minLength(1)),
  workspaceId: v.pipe(v.string(), v.minLength(1)),
  sessionId: v.pipe(v.string(), v.minLength(1)),
  machineId: v.pipe(v.string(), v.minLength(1)),
  toolId: v.picklist(TOOL_IDS),
  toolVersion: v.pipe(v.string(), v.minLength(1)),
  manifestHash: HashSchema,
  scope: CapabilityScopeSchema,
  issuedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  epoch: CountSchema,
  maxCalls: CountSchema,
  maxBytes: CountSchema,
  nonce: v.pipe(v.string(), v.minLength(1)),
  alg: v.picklist(GRANT_ALGORITHMS),
  keyId: v.pipe(v.string(), v.minLength(1)),
});

/** A grant and its signature. */
export const SignedGrantSchema: v.GenericSchema<unknown, SignedGrant> = v.strictObject({
  payload: GrantPayloadSchema,
  signature: Base64UrlSchema,
});

/** What the policy allows one tool to do. */
export const ToolPolicySchema: v.GenericSchema<unknown, PolicyDocument["tools"]["read_file"]> =
  v.strictObject({
    enabled: v.boolean(),
    scope: CapabilityScopeSchema,
    grantTtlSeconds: v.pipe(v.number(), v.integer(), v.minValue(30), v.maxValue(60)),
    maxCallsPerGrant: PositiveSchema,
  });

/** One host and port egress allows. */
export const HostPortSchema: v.GenericSchema<unknown, PolicyDocument["egress"]["hosts"][number]> =
  v.strictObject({
    host: v.pipe(v.string(), v.minLength(1)),
    port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)),
  });

/**
 * A policy's tools: each of the three tools is optional, and their fields are exact.
 *
 * @remarks
 * The declared output type is the reason this is an assertion: valibot's `strictObject` with
 * `v.optional` produces `ToolPolicy | undefined` for an absent tool, while `exactOptionalPropertyTypes`
 * makes the contract's optional fields absent-or-present (`ToolPolicy`). A missing key parses to an
 * absent key, so the asserted type is the one the value has.
 */
// SAFETY: valibot omits a missing optional key from its output, so the value is a PolicyTools.
const PolicyToolsSchema = v.strictObject({
  read_file: v.optional(ToolPolicySchema),
  write_file: v.optional(ToolPolicySchema),
  bash: v.optional(ToolPolicySchema),
}) as v.GenericSchema<unknown, PolicyTools>;

/** One policy document. */
export const PolicyDocumentSchema: v.GenericSchema<unknown, PolicyDocument> = v.strictObject({
  v: v.literal(1),
  tools: PolicyToolsSchema,
  egress: v.strictObject({ enabled: v.boolean(), hosts: v.array(HostPortSchema) }),
});

/** One immutable policy revision. */
export const PolicyRevisionSchema: v.GenericSchema<unknown, PolicyRevision> = v.strictObject({
  workspaceId: v.pipe(v.string(), v.minLength(1)),
  revision: PositiveSchema,
  hash: HashSchema,
  document: PolicyDocumentSchema,
  createdAt: IsoTimestampSchema,
  createdBy: v.pipe(v.string(), v.minLength(1)),
});

/** A proposed policy, waiting for a human. */
export const PolicyProposalSchema: v.GenericSchema<unknown, PolicyProposal> = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  workspaceId: v.pipe(v.string(), v.minLength(1)),
  baseRevision: PositiveSchema,
  baseHash: HashSchema,
  candidate: PolicyDocumentSchema,
  candidateHash: HashSchema,
  reviewToken: HashSchema,
  requestedBy: v.pipe(v.string(), v.minLength(1)),
  reason: v.string(),
  status: v.picklist(POLICY_PROPOSAL_STATUSES),
  createdAt: IsoTimestampSchema,
  decidedBy: v.optional(v.string()),
  decidedAt: v.optional(IsoTimestampSchema),
  decisionReason: v.optional(v.string()),
});

/** One thing a policy allows, as an atom. */
export const CapabilityAtomSchema: v.GenericSchema<unknown, CapabilityAtom> = v.variant("kind", [
  v.strictObject({ kind: v.literal("read"), value: v.string() }),
  v.strictObject({ kind: v.literal("write"), value: v.string() }),
  v.strictObject({ kind: v.literal("exec"), value: v.picklist(EXEC_ATOMS) }),
  v.strictObject({ kind: v.literal("egress"), value: v.string() }),
]);

/** How a candidate differs from its base, with the atoms it adds and removes. */
export const PolicyDiffSchema: v.GenericSchema<unknown, PolicyDiff> = v.strictObject({
  kind: v.picklist(POLICY_DIFF_KINDS),
  added: v.array(CapabilityAtomSchema),
  removed: v.array(CapabilityAtomSchema),
});

/** Why a call was refused. */
export const DenialCodeSchema: v.GenericSchema<unknown, (typeof DENIAL_CODES)[number]> =
  v.picklist(DENIAL_CODES);

/** The result of authorizing one call. */
export const PolicyDecisionSchema: v.GenericSchema<unknown, PolicyDecision> = v.variant("outcome", [
  v.strictObject({
    outcome: v.literal("allow"),
    policyRevision: PositiveSchema,
    policyHash: HashSchema,
    grantId: v.optional(v.string()),
  }),
  v.strictObject({
    outcome: v.literal("deny"),
    code: DenialCodeSchema,
    message: v.string(),
    policyRevision: v.optional(PositiveSchema),
    policyHash: v.optional(HashSchema),
  }),
]);

/** What every audit event shares. */
const AuditEventBaseEntries = {
  v: v.literal(1),
  eventId: v.pipe(v.string(), v.minLength(1)),
  at: IsoTimestampSchema,
  workspaceId: v.pipe(v.string(), v.minLength(1)),
  sessionId: v.pipe(v.string(), v.minLength(1)),
  callId: v.pipe(v.string(), v.minLength(1)),
  callHash: HashSchema,
  argsHash: HashSchema,
  toolId: v.picklist(TOOL_IDS),
  toolVersion: v.pipe(v.string(), v.minLength(1)),
  manifestHash: HashSchema,
  grantId: v.optional(v.string()),
  prevHash: v.nullable(HashSchema),
  hash: HashSchema,
};

/** One append-only audit entry: a `tool.call` or a `tool.result`. */
export const AuditEventSchema: v.GenericSchema<unknown, AuditEvent> = v.variant("event", [
  v.strictObject({ ...AuditEventBaseEntries, event: v.literal("tool.call") }),
  v.strictObject({
    ...AuditEventBaseEntries,
    event: v.literal("tool.result"),
    decision: PolicyDecisionSchema,
    durationMs: CountSchema,
  }),
]);
