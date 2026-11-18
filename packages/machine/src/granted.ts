import { createHash } from "node:crypto";
import * as v from "valibot";
import { ToolCallSchema, ToolManifestSchema, deny } from "@hns/core/capability";
import type { AllowDecision, DenyDecision, ToolCall } from "@hns/core/capability";
import { ActivePolicySchema } from "@hns/workspace/protocol";
import type { GrantedCallPayload } from "@hns/workspace/protocol";
import type { GrantCounter } from "./capability/counter.ts";
import { authorizeGrantedCall } from "./capability/decision.ts";
import type { GrantKeys } from "./capability/keys.ts";
import type { MachineExec } from "./exec.ts";
import type { Limits } from "./limits.ts";
import type { OperationResult } from "./operations.ts";
import { runOperation } from "./operations.ts";
import type { RootIdentity } from "@hns/workspace";
import type { Operation } from "./wire.ts";

/**
 * One granted tool call, decided and run on the machine (0226, `docs/capability.md` §5, §10).
 *
 * @remarks
 * This is the machine's whole half of a granted call, and the order is the contract's:
 *
 * 1. **the manifest is the tool's contract** — the call, the manifest the request carries, and the
 *    grant's `toolId` / `toolVersion` / `manifestHash` must be one tool's. The check is in core's
 *    `authorizeCall` (a call it cannot match is `manifest_mismatch`), so this function only passes
 *    the values through; nothing here decides a second way.
 * 2. **the grant is verified** — signature, algorithm, revocation, expiry, epoch, the active policy
 *    the control channel relayed, the scope of the call, and finally the budget
 *    ({@link ./capability/decision.ts authorizeGrantedCall}). A denial never runs anything, and
 *    never spends the grant it was offered for.
 * 3. **the operation is reconstructed from the call** — a `read_file` call is a read of its path, a
 *    `write_file` call is a write, and a `bash` call is an exec of its command. The call's fields
 *    are the only source; the request has no second place to name a path or a command.
 * 4. **the operation runs** with the tool's output bound, under the request's deadline.
 *
 * **What the machine does not know.** Revocation is the issuer's state: this machine is told nothing
 * when the Session object revokes a run's grants, so its own defence is the grant's `expiresAt`
 * (at most 60 seconds, and the verifier refuses a grant past it) and its counter. The relay in front
 * of it refuses a revoked grant before the request reaches the machine; the window between the
 * revocation and the expiry is the residual one, and it is written here rather than implied.
 *
 * **The counter's owner is this machine** — the `GrantCounter` file under `~/.config/hns/grants`,
 * which the agent's shell cannot read (0194). The Session object's record of a grant is its issuance;
 * the calls spent against it are counted here, before the tool runs.
 */

/** What one granted call is run with: the machine's state and the request's budget. */
export interface GrantedCallInput {
  /**
   * The relayed call: the grant, the call, its manifest, and the active policy.
   *
   * @remarks
   * The request is JSON on the wire, and every member of it is checked before use: the grant by
   * the verifier, the call and the manifest by the contract's own schemas. It is typed loosely for
   * that reason, so a body that lacks a member reaches the verifier as the denial it is instead of
   * being promised by a type it never had.
   */
  readonly request: GrantedCallPayload;
  /** The enrolled control-plane keys, by `keyId`. */
  readonly keys: GrantKeys;
  /** The per-grant budget the machine keeps. */
  readonly counter: GrantCounter;
  /** This machine's id, as its Machine record names it. */
  readonly machineId: string;
  /** The machine's clock. */
  readonly now: Date;
  /** The canonical ROOT and its identity at start. */
  readonly root: string;
  readonly identity: RootIdentity | undefined;
  /** The request's deadline; every step checks it. */
  readonly signal: AbortSignal;
  /** The machine's response bound, for the operation's own limits. */
  readonly limits: Limits;
  /** The sandbox, or the fail-closed state that refuses every command. */
  readonly exec: MachineExec;
  /** The newest policy revision this machine has accepted, when it records one. */
  readonly lastEpoch?: number | undefined;
  /**
   * The grant ids this machine knows are revoked.
   *
   * @remarks
   * A machine keeps no revocation list of its own (revocation is the issuer's state), so this is
   * what a caller that **does** know passes: the relay in front of the machine refuses a revoked
   * grant before it relays it, and this is the same answer enforced on this side of the wire.
   * Omitted means the machine knows nothing; its defence is then the grant's 60-second life and
   * its counter.
   */
  readonly revokedGrants?: ReadonlySet<string> | undefined;
}

/** What one granted call came to. */
export type GrantedCallOutcome =
  | { readonly kind: "denied"; readonly decision: DenyDecision }
  | {
      readonly kind: "allowed";
      readonly decision: AllowDecision & { readonly outcome: "allow" };
      readonly grantId: string;
      readonly result: OperationResult;
    };

/**
 * The argument names each tool's operation reads.
 *
 * @remarks
 * The same names core's `authorizeCall` requires before it judges a scope: the machine runs the
 * values the grant was checked against, so a call it runs has exactly those.
 */
/** A bash call's timeout: absent, or a whole number of milliseconds. */
const ExecTimeoutSchema = v.optional(v.number());

/**
 * The argument names each tool's operation reads.
 *
 * @remarks
 * The same names core's `authorizeCall` requires before it judges a scope: the machine runs the
 * values the grant was checked against, so a call it runs has exactly those.
 */
const OPERATION_FIELDS: Readonly<Record<ToolCall["toolId"], readonly string[]>> = {
  read_file: ["path"],
  write_file: ["path", "content", "expectedVersion"],
  bash: ["command"],
};

/**
 * One argument of a call, parsed as the kind the tool's operation takes.
 *
 * @param call - The call, whose arguments the contract holds as untrusted payload.
 * @param field - The argument's name.
 * @returns The string, or the defect it would be for it to be another type.
 * @throws Error when the argument is not a string: core's `authorizeCall` reads the operation
 * fields by presence, so an ill-typed one is a defect in the call's producer, not a caller refusal.
 */
function stringArgument(call: ToolCall, field: string): string {
  const parsed = v.safeParse(v.string(), call.args[field]);
  if (!parsed.success) {
    throw new Error("a " + call.toolId + " call's " + field + " is not a string");
  }
  return parsed.output;
}

/**
 * The operation's idempotency key, derived from the call id.
 *
 * @remarks
 * The workspace's `operationId` codec accepts a bounded set of characters; a durable call id
 * (`tool:<ms>:<id>`) is mapped the same way the agent maps it (`operationIdFor`), and a call id that
 * cannot be mapped is the call's own refusal at the workspace. The machine maps it here because the
 * write is what needs an id and the relay does not build one: one derivation, one string.
 */
function operationIdOf(call: ToolCall): string {
  const mapped = "call-" + call.callId;
  if (!/^[A-Za-z0-9._~-]{1,128}$/u.test(mapped)) {
    throw new Error("the call id cannot name a write");
  }
  return mapped;
}

/**
 * The exec a bash call names: its command, its cwd, and its timeout.
 *
 * @remarks
 * The command runs in the workspace root (the model's cwd is the project root, which the relay's
 * workspace is), and `timeoutMs` is the call's own budget, never longer than the request's deadline.
 * The call's `envelope` is part of its identity and was checked against the grant's exec scope; the
 * sandbox is what carries it out (the machine's own egress and writable configuration).
 */
function execOf(call: ToolCall): Operation {
  const parsed = v.safeParse(ExecTimeoutSchema, call.args["timeoutMs"]);
  if (!parsed.success) throw new Error("a bash call's timeoutMs is not a number");
  const command = stringArgument(call, "command");
  // No cwd: the machine's exec starts in ROOT, which is the workspace the grant's paths are
  // relative to. Naming "." would be resolved as ROOT/"." and is not the same check.
  return parsed.output === undefined
    ? { op: "exec", command }
    : { op: "exec", command, timeoutMs: parsed.output };
}

/**
 * The operation a tool call names: its arguments, as the scope checks read them.
 *
 * @throws {Error} Only for a defect in this module: the verifier already refused a call without its
 * operation fields (`scope_exceeded`), so a call that reaches here has them.
 */
function operationOf(call: ToolCall): Operation {
  for (const field of OPERATION_FIELDS[call.toolId]) {
    if (!(field in call.args)) {
      throw new Error("a call without " + field + " reached the machine");
    }
  }
  switch (call.toolId) {
    case "read_file":
      return { op: "read", path: stringArgument(call, "path") };
    case "write_file": {
      const content = stringArgument(call, "content");
      const bytes = Buffer.from(content, "utf8");
      return {
        op: "write",
        // The model's paths are project-relative and the relay's ROOT is the project, so the write
        // names no second root: the path the grant's scope was checked against is ROOT-relative.
        projectRoot: "",
        path: stringArgument(call, "path"),
        content: bytes.toString("base64"),
        // The machine re-hashes what it received, so a body cut or edited in transit is refused
        // rather than written (0147's intent hash, the same one a Worker's write carries).
        contentHash: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
        expectedVersion: stringArgument(call, "expectedVersion"),
        // The call id is the write's idempotency key: a retried call names one operation, and the
        // workspace's journal already decided it.
        operationId: operationIdOf(call),
      };
    }
    case "bash":
      return execOf(call);
    default: {
      const unhandled: never = call.toolId;
      throw new Error("a tool the machine does not run: " + String(unhandled));
    }
  }
}

/**
 * Decide one granted call and run it when it is allowed.
 *
 * @param input - The relayed call, the machine's state, and the request's budget.
 * @returns The allow with the grant id and the operation's result, or the denial that refused it.
 *
 * @throws {MachineRefusal} Whatever the operation refuses with: a path outside ROOT, a missing
 * parent, output over the bound, a deadline. Those are the machine's refusals, and the caller
 * records them as the call's failure, not as a decision.
 * @throws {Error} Only for a defect in this module; every refusal a caller can cause is the decision.
 */
export async function runGrantedCall(input: GrantedCallInput): Promise<GrantedCallOutcome> {
  const { request } = input;
  const call = v.safeParse(ToolCallSchema, request.call);
  const manifest = v.safeParse(ToolManifestSchema, request.manifest);
  if (!call.success || !manifest.success) {
    return {
      kind: "denied",
      decision: deny("manifest_mismatch", "the call is not a tool call of this manifest"),
    };
  }
  // The policy and the byte count are the control channel's; a body that does not carry them as
  // they are declared reaches the verifier as the refusal it is (no policy is `policy_denied`).
  const activePolicy = v.safeParse(ActivePolicySchema, request.activePolicy);
  const bytes = v.safeParse(v.pipe(v.number(), v.integer(), v.minValue(0)), request.bytes);
  const authorized = await authorizeGrantedCall({
    grant: request.authorization,
    call: call.output,
    manifest: manifest.output,
    keys: input.keys,
    counter: input.counter,
    machineId: input.machineId,
    now: input.now,
    activePolicy: activePolicy.success ? activePolicy.output : undefined,
    bytes: bytes.success ? bytes.output : Number.POSITIVE_INFINITY,
    lastEpoch: input.lastEpoch,
    revokedGrants: input.revokedGrants,
  });
  input.signal.throwIfAborted();
  if (authorized.decision.outcome === "deny") {
    // A deny is a value: the caller records it and tells the model, and nothing ran.
    return { kind: "denied", decision: authorized.decision };
  }
  if (authorized.grant === undefined) {
    // An allow without the grant it was decided on is this module's defect, never a value the
    // caller could act on: nothing is run.
    throw new Error("an allowed granted call carries no grant");
  }
  // The operation is rebuilt from the call the grant was checked against, after the decision: a
  // denial never reaches the file system or the shell.
  const operation = operationOf(call.output);
  const result = await runOperation(
    operation,
    input.root,
    input.limits,
    input.signal,
    input.identity,
    input.exec,
  );
  return {
    kind: "allowed",
    decision: authorized.decision,
    grantId: authorized.grant.payload.grantId,
    result,
  };
}
