import * as v from "valibot";
import {
  PolicyDecisionSchema,
  SignedGrantSchema,
  ToolCallSchema,
  ToolManifestSchema,
} from "@hns/core/capability";
import type { JsonValue } from "@hns/core";
import type { PolicyDecision, SignedGrant, ToolCall, ToolManifest } from "@hns/core/capability";

/**
 * What every helper call carries: which root, and which directory must still be there.
 *
 * @remarks
 * `root` must be absolute. `id` is the journal identity: the helper reads the
 * root's own marker through the opened dirfd and refuses one that names another
 * workspace, so a swapped directory cannot impersonate the root. `dev` and
 * `ino` are the ones the probe recorded; they are absent only while probing.
 *
 * @internal
 */
export interface HelperBase {
  readonly root: string;
  /** Journal id; the helper refuses a root whose marker names another one. */
  readonly id: string;
  /** Device and inode of the root recorded by the probe; absent while probing. */
  readonly dev?: number | undefined;
  readonly ino?: number | undefined;
}

const HELPER_OPS = ["probe", "hash", "read", "commit"] as const;
/**
 * The helper operations, in one closed vocabulary.
 *
 * @remarks
 * Each request runs one helper process, and the op name is also its first argv
 * word, so the helper can check it before reading paths.
 *
 * @internal
 */
export type HelperOp = (typeof HELPER_OPS)[number];

/**
 * One operation, as argv: the op name and JSON. Every path is a list of names
 * below the root, so the helper never sees ".." or an absolute path.
 *
 * @remarks
 * `commit` names the target as names below the root and the temp as a single
 * name beside it, because the helper renames from one dirfd to another. The
 * helper re-validates every component; this type only carries them.
 *
 * @internal
 */
export type HelperRequest =
  | (HelperBase & { readonly op: "probe" })
  | (HelperBase & { readonly op: "hash"; readonly path: readonly string[] })
  | (HelperBase & { readonly op: "read"; readonly path: readonly string[] })
  | (HelperBase & {
      readonly op: "commit";
      readonly path: readonly string[];
      readonly temp: string;
      readonly expectedVersion: string;
    });

/**
 * What the helper prints. The client checks the shape before using it.
 *
 * @remarks
 * This is untrusted text from another process: a reply that does not match one
 * of these variants becomes a failed outcome, never a trusted value.
 *
 * @internal
 */
export type HelperReply =
  | { readonly ok: true; readonly dev: number; readonly ino: number }
  | { readonly ok: true; readonly version: string }
  | { readonly ok: true; readonly base64: string; readonly size: number }
  | { readonly ok: true; readonly status: "applied" }
  | { readonly ok: true; readonly status: "conflict"; readonly currentVersion: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * What the client reports to the workspace, after checking the reply.
 *
 * @remarks
 * `failed` keeps the helper's code vocabulary (`not_found`, `root_replaced`,
 * `root_missing`, `invalid`, ...) so the workspace can map it to a Denied or a
 * FileFailure instead of parsing a message.
 *
 * @internal
 */
export type HelperOutcome =
  | { readonly kind: "probe"; readonly dev: number; readonly ino: number }
  | { readonly kind: "version"; readonly version: string }
  | { readonly kind: "content"; readonly bytes: Uint8Array }
  | { readonly kind: "applied" }
  | { readonly kind: "conflict"; readonly currentVersion: string }
  | { readonly kind: "failed"; readonly code: string; readonly message: string };

const rootFields = {
  root: v.pipe(v.string(), v.regex(/^\//)),
  id: v.string(),
  dev: v.optional(v.number()),
  ino: v.optional(v.number()),
};

const RequestSchema: v.GenericSchema<unknown, HelperRequest> = v.variant("op", [
  v.object({ ...rootFields, op: v.literal("probe") }),
  v.object({ ...rootFields, op: v.literal("hash"), path: v.array(v.string()) }),
  v.object({ ...rootFields, op: v.literal("read"), path: v.array(v.string()) }),
  v.object({
    ...rootFields,
    op: v.literal("commit"),
    path: v.array(v.string()),
    temp: v.string(),
    expectedVersion: v.string(),
  }),
]);

const ReplySchema = v.union([
  v.object({ ok: v.literal(false), code: v.string(), message: v.string() }),
  v.object({ ok: v.literal(true), dev: v.number(), ino: v.number() }),
  v.object({ ok: v.literal(true), version: v.string() }),
  v.object({
    ok: v.literal(true),
    base64: v.string(),
    size: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
  v.object({ ok: v.literal(true), status: v.literal("applied") }),
  v.object({ ok: v.literal(true), status: v.literal("conflict"), currentVersion: v.string() }),
]);

/** The marker inside the root, which names the workspace that owns it. */
const MarkerSchema = v.object({ id: v.string() });

/**
 * Parse what the workspace passed to the helper. Throws on anything else.
 *
 * @param text - The JSON payload from argv.
 * @returns A request whose root is absolute and whose path is a string array.
 * The path components are checked by `namesOf` before the helper uses them.
 * @throws When the payload is not JSON, or does not match a request shape: a
 * syntax error or valibot's validation error.
 *
 * @internal
 */
export function parseRequest(text: string): HelperRequest {
  return v.parse(RequestSchema, JSON.parse(text));
}

const failed = (code: string, message: string): HelperOutcome => ({
  kind: "failed",
  code,
  message,
});

/**
 * Turn the helper's stdout into an outcome the workspace can act on.
 *
 * @param op - The request that produced the reply; the reply must fit its shape.
 * @param text - The helper's stdout.
 * @returns An outcome; malformed output becomes `failed("io", ...)` rather than
 * an exception, because a helper that printed nothing is a failed operation and
 * not a crash in the caller.
 *
 * @internal
 */
export function parseReply(op: HelperOp, text: string): HelperOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return failed("io", "the helper printed nothing usable");
  }
  const parsed = v.safeParse(ReplySchema, raw);
  if (!parsed.success) return failed("io", "the helper reply is unreadable");
  const reply = parsed.output;
  if (!reply.ok) return failed(reply.code, reply.message);
  switch (op) {
    case "probe":
      return "dev" in reply
        ? { kind: "probe", dev: reply.dev, ino: reply.ino }
        : failed("io", "no device");
    case "hash":
      return "version" in reply
        ? { kind: "version", version: reply.version }
        : failed("io", "no version");
    case "read": {
      if (!("base64" in reply) || !("size" in reply)) return failed("io", "no content");
      const bytes = Buffer.from(reply.base64, "base64");
      // Base64 decoders drop bad characters, so the length is the only sign of a cut reply.
      if (bytes.length !== reply.size) return failed("io", "the helper reply is the wrong length");
      return { kind: "content", bytes };
    }
    case "commit":
      if (!("status" in reply)) return failed("io", "no verdict");
      if (reply.status === "applied") return { kind: "applied" };
      return "currentVersion" in reply
        ? { kind: "conflict", currentVersion: reply.currentVersion }
        : failed("io", "no conflicting version");
  }
}

/**
 * The id a root marker names, or undefined when the text is not one.
 *
 * @param text - The raw marker file body.
 * @returns The marker's id, or undefined for absent, unparsable, or shapeless
 * text. Callers decide what undefined means: an existing workspace refuses, while
 * a new workspace may mint an id.
 *
 * @internal
 */
export function parseMarker(text: string): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = v.safeParse(MarkerSchema, raw);
  return parsed.success ? parsed.output.id : undefined;
}

/**
 * The active policy revision a granted call is decided under, as the Session object relays it.
 *
 * @remarks
 * The machine's verifier refuses a grant it cannot compare with an active revision (0225), so this
 * is the control-channel half of every granted call: the revision number and the document's hash,
 * never the document itself. A caller that omits it relays nothing the machine can check, and the
 * machine answers `policy_denied` (fail closed).
 *
 * @internal
 */
export const ActivePolicySchema: v.GenericSchema<
  unknown,
  { readonly revision: number; readonly hash: string }
> = v.strictObject({
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  hash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
});

/**
 * One granted tool call, as the Worker relays it to the machine (0226, `docs/capability.md` §10).
 *
 * @remarks
 * The body is the signed request's whole content: the grant (`authorization`), the call it is spent
 * on, the tool's manifest, the active policy the machine must compare the grant with, and the bytes
 * the caller is willing to count against the grant's `maxBytes`. The machine reconstructs the call
 * from these fields and re-hashes it: a body that names a different call than the grant was issued
 * for is refused (`manifest_mismatch` / `scope_exceeded`), never executed.
 *
 * `op: "tool"` is a machine operation the helper protocol does not have: this module is where both
 * request envelopes are defined, so the Worker's relay and the machine's server parse one contract.
 *
 * @internal
 */
export interface GrantedCall {
  readonly op: "tool";
  /** The signed grant; the capability itself, and the one value a log must never carry. */
  readonly authorization: SignedGrant;
  /** The call the machine runs, built from the tool's arguments. */
  readonly call: ToolCall;
  /** The tool's contract, as the agent built it; the machine checks the grant against it. */
  readonly manifest: ToolManifest;
  /** The active policy revision the control channel presented for this call. */
  readonly activePolicy: { readonly revision: number; readonly hash: string };
  /** The model-facing bytes this call may return, counted against `maxBytes`. */
  readonly bytes: number;
}

/**
 * The schema of one granted call, parsed before the machine decides anything.
 *
 * @internal
 */
export const GrantedCallSchema: v.GenericSchema<unknown, GrantedCall> = v.strictObject({
  op: v.literal("tool"),
  authorization: SignedGrantSchema,
  call: ToolCallSchema,
  manifest: ToolManifestSchema,
  activePolicy: ActivePolicySchema,
  bytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

/**
 * Parse one granted call from a request body.
 *
 * @param body - The exact bytes that were signed.
 * @returns The request, parsed.
 * @throws {Error} When the bytes are not a granted call: a body that cannot be read as one is never
 * decided, and the machine answers it as a refusal before any operation runs.
 *
 * @internal
 */
export function parseGrantedCall(body: Uint8Array): GrantedCall {
  return v.parse(GrantedCallSchema, JSON.parse(new TextDecoder().decode(body)));
}

/**
 * A granted call as the machine receives it: unparsed, because every member of it is checked.
 *
 * @remarks
 * The wire body is JSON; the machine parses the grant with the contract's schema and the call and
 * manifest with theirs before it decides anything. This type says "not yet parsed" so a body that
 * lacks a member is still a value the machine refuses, never a promise its type made.
 *
 * @internal
 */
export type GrantedCallPayload = {
  readonly op: "tool";
  readonly authorization?: unknown;
  readonly call?: unknown;
  readonly manifest?: unknown;
  readonly activePolicy?: unknown;
  readonly bytes?: unknown;
};

/**
 * What the machine answered one granted call.
 *
 * @remarks
 * A denial is a value with its `PolicyDecision` (the denial vocabulary, `docs/capability.md` §7), not
 * a transport failure: the caller records the decision and tells the model. A result is present only
 * for an allowed call, and it is the operation's own answer (a read's content, a write's outcome, or
 * an exec's output).
 *
 * @internal
 */
export type GrantedAnswer =
  | {
      readonly decision: PolicyDecision & { readonly outcome: "deny" };
      readonly grantId?: undefined;
      readonly result?: undefined;
    }
  | {
      readonly decision: PolicyDecision & { readonly outcome: "allow" };
      /** The grant that was decided on (its id is what the audit records). */
      readonly grantId: string;
      /** The operation's result, as the machine answered it. */
      readonly result: unknown;
    };

/**
 * The schema of the machine's answer, for the Worker's relay.
 *
 * @internal
 */
export const GrantedAnswerSchema: v.GenericSchema<unknown, GrantedAnswer> = v.custom<GrantedAnswer>(
  (value) => v.safeParse(GrantedAnswerVariant, value).success,
);

/**
 * The answer's shape: a decision, and for an allow the grant's id and the operation's result.
 *
 * @remarks
 * The decision is parsed by the contract's own schema; the variant is then narrowed by its
 * `outcome`, so an allow without a `grantId` is refused rather than read as a grant-less allow.
 */
const GrantedAnswerVariant = v.variant("decision", [
  v.object({
    decision: v.pipe(
      PolicyDecisionSchema,
      v.check((decision) => decision.outcome === "deny", "a denial is a deny decision"),
    ),
  }),
  v.object({
    decision: v.pipe(
      PolicyDecisionSchema,
      v.check((decision) => decision.outcome === "allow", "an answer is an allow decision"),
    ),
    grantId: v.pipe(v.string(), v.minLength(1)),
    result: v.unknown(),
  }),
]);

/**
 * The header a run's tool relay carries: the token the Session object minted for that run.
 *
 * @remarks
 * The agent's tool code reaches the machine only through this header and this route. The object
 * checks the token against the run the route names, so an agent that holds another run's token (or
 * a forged one) cannot relay a call as that run, and a grant issued for a run cannot be spent
 * outside it. The header value is a secret: a log line never carries it.
 *
 * @internal
 */
export const TOOL_RUN_TOKEN_HEADER = "x-hns-tool-token";

/**
 * The internal route a run's granted calls are relayed on, below the Session's RPC prefix.
 *
 * @remarks
 * `POST /rpc/conversations/<runId>/tool`. The run id in the path is the one the token was minted
 * for, and the one the call's grants are bound to (so the object can revoke them when it ends).
 *
 * @internal
 */
export const TOOL_RUN_ROUTE = "/tool";

/**
 * How long a run's relay token lives, in milliseconds.
 *
 * @remarks
 * A turn's tool calls happen within its run; the token is minted with the run and checked with the
 * caller's clock, so a token that outlived its run is refused even if the grant did not.
 *
 * @internal
 */
export const TOOL_RUN_TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * The Worker's policy snapshot, as the internal RPC body carries it: a JSON object.
 *
 * @remarks
 * Its members are the issuer's own (`PolicySnapshotSchema`, 0224); this is only what the Session
 * RPC's boundary parses it as before the object's state parses it for real. It exists so a caller
 * (the send route, a probe, a test) names one type instead of asserting one.
 *
 * @internal
 */
export type PolicySnapshotBody = Readonly<Record<string, JsonValue>>;

/** The schema of a policy snapshot body: any JSON object, decided by its owner's schema. */
export const PolicySnapshotBodySchema: v.GenericSchema<unknown, PolicySnapshotBody> =
  v.custom<PolicySnapshotBody>((value) => v.safeParse(JsonObjectMembers, value).success);

/** A JSON object's members: a value's own keys, each mapped to itself. */
const JsonObjectMembers = v.record(
  v.string(),
  v.union([
    v.null(),
    v.boolean(),
    v.number(),
    v.string(),
    v.array(v.unknown()),
    v.record(v.string(), v.unknown()),
  ]),
);
