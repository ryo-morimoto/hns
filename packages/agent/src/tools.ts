import type { Context } from "@earendil-works/chord";
import { ToolTask } from "@earendil-works/pi-durable";
import { defineExtension, defineTool, hook } from "@earendil-works/pi-durable";
import type {
  Extension,
  HookApi,
  JsonObject,
  ToolExecutionResult,
  ToolHooks,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { obj, str } from "@earendil-works/pi-schema";
import * as v from "valibot";
import { operationIdFrom } from "@hns/core";
import type { MutationResult, OperationId } from "@hns/core";
import type { DenialCode, PolicyDecision, SignedGrant, ToolId } from "@hns/core/capability";
import type { Workspace } from "@hns/workspace";
import {
  INVALID_ARGUMENTS,
  admitCall,
  appendEvent,
  definitionOf,
  isWriteFileArguments,
  manifestFor,
  phase0Deny,
  succeeded,
} from "./capability.ts";
import type {
  AuditIdentity,
  AuditSink,
  BashInput,
  CallIdentity,
  CallRecord,
  CallSinks,
  ReadFileArguments,
  ToolArguments,
  ToolCallSpec,
  ToolIdentity,
  WriteFileArguments,
} from "./capability.ts";
import type { AgentEventSink } from "./events.ts";
import { failureOf } from "./failure.ts";
import type { ReadReply, ToolFailure } from "./failure.ts";
import {
  GrantUnavailableError,
  ToolTransportError,
  grantRequestFor,
  grantUnavailableDecision,
  relayUnavailableDecision,
} from "./runtime.ts";
import type { GrantSource, ToolContract, ToolTransport } from "./runtime.ts";
import type { ShellAccess } from "./shell.ts";

/** Model-facing read size, in characters. Worst-case JSON escaping is 6x, so 256 KiB covers it. */
const MAX_READ_CONTENT = 32 * 1024;

/**
 * What one granted call counts against its grant's `maxBytes`.
 *
 * @param grant - The grant the call is about to spend, as the issuer signed it.
 * @returns The grant's byte bound divided over the calls it covers, and at least one byte.
 *
 * @remarks
 * The machine charges each call against the grant's `maxBytes` before the call runs, and the grant's
 * budget is the **policy's** (`maxCalls` = `maxCallsPerGrant`, `maxBytes` = the manifest's ceiling,
 * both clamped by the issuer). Charging each call its share of that budget lets a grant pay for the
 * calls the policy granted; charging the whole bound per call would make the second call of the same
 * tool `counter_exhausted`, which is the cache's whole point. The numbers come from the signed
 * grant, never from a constant here.
 */
function grantCallBytes(grant: SignedGrant): number {
  const perCall = Math.floor(grant.payload.maxBytes / Math.max(1, grant.payload.maxCalls));
  return Math.max(1, perCall);
}

/** The largest wait a bash call may name, in milliseconds: one day. */
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Derive the write operationId from the tool call id.
 *
 * @param callId - Durable's call id, shaped "tool:<ms>:<id>".
 * @returns An OperationId derived from "call-" plus the call id, mapped and capped by the codec.
 *
 * @remarks
 * The id comes from the call, not from the model's arguments: the model cannot
 * repeat it to force a replay, and a retried call keeps the idempotency key the
 * workspace already recorded.
 */
export function operationIdFor(callId: string): OperationId {
  return operationIdFrom("call-" + callId);
}

/**
 * The granted path for the conversation a tool call runs in.
 *
 * @param identity - What the call's audit rows name; its `sessionId` is the conversation, which is
 * the run whose grants the call may spend.
 * @returns The path, or `undefined` for a call that runs in this process (Phase 0).
 */
export type GrantPathOf = (identity: AuditIdentity | undefined) => WorkspaceGrants | undefined;

/**
 * What workspaceTools needs: the workspace to expose, whether exec is offered, where
 * observations go, and where the audit goes.
 */
export interface WorkspaceToolsOptions {
  readonly workspace: Workspace;
  /** Decides whether bash is registered; only "sandboxed" adds it. */
  readonly shell: ShellAccess;
  /** Receives tool.call and tool.result around each execution. Not awaited. */
  readonly onEvent?: AgentEventSink | undefined;
  /**
   * Receives the contract's audit events. `tool.call` is **awaited before the call runs** and
   * `tool.result` **before the result returns**: a sink that rejects refuses the call and the result
   * does not reach the model (fail closed, `docs/capability.md` §8). Omitted: calls run and their
   * observations are emitted, but no audit row is written.
   */
  readonly audit?: AuditSink | undefined;
  /** What an audit event names; required when `audit` is given. */
  readonly auditIdentity?: AuditIdentity | undefined;
  /**
   * The granted path: where grants come from and where calls are relayed; **absent means Phase 0**.
   *
   * @remarks
   * With it, every admitted call is decided by its machine: the agent asks for a grant (cached per
   * tool × manifest × machine), relays the call with the grant, and runs nothing unless the machine
   * allowed it. Without it the tools keep the Phase 0 path — the agent's own admission is the
   * decision, and the call runs in this process — which is what a deployment with the granted path
   * switched off, and every pre-existing caller, gets. This is the one kill switch: nothing else in
   * the tools turns the granted path on.
   */
  readonly grants?: GrantPathOf | undefined;
}

/**
 * What the granted path needs: the issuer and the machine's relay.
 *
 * @remarks
 * Both are the caller's: the Session object owns the run (its token and its revocations), and the
 * issuer is the object's own. The agent holds no key, no URL, and no policy.
 */
export interface WorkspaceGrants {
  /** Where a grant for one tool contract is asked for (the Session's issuer, cached). */
  readonly source: GrantSource;
  /** Where a granted call is relayed (the Session's relay for this run). */
  readonly transport: ToolTransport;
}

/**
 * Wrap a tool's JSON value as the single text item the model reads.
 *
 * @remarks
 * Success and refusal share one envelope, so a refused call parses like a result
 * instead of arriving as prose.
 */
const text = (
  value: ReadReply | ToolFailure | MutationResult,
): NonNullable<ToolExecutionResult["output"]> => [{ type: "text", text: JSON.stringify(value) }];

/**
 * Turn a refusal into an error result: isError marks the call failed, and the same
 * JSON envelope as a success carries the reason for the model to read.
 */
const failureReply = (failure: ToolFailure): ToolExecutionResult => ({
  output: text(failure),
  isError: true,
});

if (import.meta.vitest) {
  const { expect, test } = import.meta.vitest;
  test("a refused call is an error result whose text carries the failure", () => {
    const result = failureReply({ ok: false, status: "denied", message: "outside the root" });
    expect(result.isError).toBe(true);
    expect(result.output).toEqual([
      { type: "text", text: '{"ok":false,"status":"denied","message":"outside the root"}' },
    ]);
  });
}

/**
 * The sinks a call reports to.
 *
 * @param options - The workspace tools' options.
 * @throws Error when an audit sink has no identity to record events under: a wiring defect, not a
 * call's refusal.
 */
function sinksOf(options: WorkspaceToolsOptions): CallSinks {
  const { audit, auditIdentity } = options;
  if (audit !== undefined && auditIdentity === undefined) {
    throw new Error("an audit sink needs the workspace and session it records under");
  }
  return audit === undefined || auditIdentity === undefined
    ? { onEvent: options.onEvent }
    : { onEvent: options.onEvent, audit, auditIdentity };
}

/** What one call's admission left for its result. */
interface Admitted {
  /** The call's identity; absent for one `beforeTool` refused (it never became a hashed call). */
  readonly call: CallIdentity | undefined;
  readonly decision: PolicyDecision;
  readonly startedAt: number;
  /**
   * What the tool receives when the call ran on its machine, instead of the tool's own execution.
   *
   * @remarks
   * The granted path decides and runs a call at one machine, so `beforeTool` already has the result;
   * the registered tool then returns it unchanged (see `servedResult`). Absent on the Phase 0 path,
   * where the tool runs here.
   */
  readonly served?: ToolExecutionResult | undefined;
}

/**
 * One extension's calls, by the call id `beforeTool` admitted.
 *
 * @remarks
 * `beforeTool` writes an entry and `afterTool` reads and deletes it: a refused call's entry has no
 * `call`, and no entry at all means pi-durable refused the arguments before either hook ran.
 */
type CallMemory = Map<string, Admitted>;

/**
 * What each call's granted path already ran, by call id.
 *
 * @remarks
 * The result is produced in `beforeTool` (the machine's answer), but the registered tool's
 * `execute` is what reads a memory it shares with the hooks: the hooks cannot hand a value to
 * `execute`, so the served result waits here for the tool that is about to be called with this id.
 * `execute` deletes the entry; a call that never reaches its tool leaves it for the tool to find,
 * and a later call has another id.
 */
type ServedMemory = Map<string, ToolExecutionResult>;

/** The served results, per extension, keyed the way the tool hooks' memory is. */
const servedResults = new WeakMap<Extension, ServedMemory>();

/**
 * The result a tool returns when its call already ran on its machine.
 *
 * @param extension - The extension whose tools run.
 * @param callId - The call pi-durable is executing.
 * @returns The served result, or undefined when this call runs here (Phase 0, or a refusal that
 * never reached the machine).
 *
 * @remarks
 * A tool built by `workspaceTools` checks here before it touches the workspace: on the granted path
 * the machine already did the work, and running it a second time here would be a second execution of
 * one call.
 */
export function servedResultFor(
  extension: Extension,
  callId: string,
): ToolExecutionResult | undefined {
  const served = servedResults.get(extension);
  const result = served?.get(callId);
  served?.delete(callId);
  return result;
}

/** What the tool hooks need: the tools, the sinks, the environment, and the call memory. */
interface ToolHookOptions {
  identityOf: (name: string) => Promise<ToolIdentity>;
  sinks: CallSinks;
  env: ShellAccess["env"];
  memory: CallMemory;
  /**
   * The granted path for the conversation a call runs in; absent means Phase 0.
   *
   * @remarks
   * With it, an admitted call is decided by its machine and its result comes from there; the
   * registered tools never run it themselves in this process. It is a function because a Session
   * gives each **run** its own path: the identity's session id is the conversation the tool runs
   * in, which is the run whose grant the call may spend. A fixed path is a function that answers
   * it for every identity.
   */
  grants?: GrantPathOf | undefined;
  /** Where a granted call's result waits for its tool to return it. */
  served: ServedMemory;
}

/**
 * The tool task's hooks: admission before the tool runs, the harness's verdict after it settles.
 *
 * @param options - The tools, the sinks, the environment, and the call memory.
 * @returns The handlers for pi-durable's tool task (`hook(ToolTask, handlers)`).
 *
 * @remarks
 * **The tools are registered as pi-durable defines them; the hooks wrap them.** That keeps the result
 * contract the harness's own (`isError`, `structuredOutput`, `exitCode`): `succeeded` reads it the way
 * the harness does, and `afterTool` returns the result unchanged. The audit sits where the contract
 * wants it: `tool.call` awaited before the tool runs, `tool.result` awaited before the result is
 * committed.
 *
 * The four ways a call settles, and what is recorded for each:
 * - **admitted and run**: `tool.call` before, `tool.result` after, with the admitted decision.
 * - **refused** (the strict schema, the path, or the canonical form): the `tool.call` is written and
 *   its decision denies the call; `beforeTool` throws, so the tool never runs and the model reads the
 *   harness's refusal whose text is {@link refusalWording}. The decision's `code` is the audit's
 *   vocabulary, not the model's.
 * - **invalid arguments** (pi-durable's own validation, before any hook): nothing ran, so only the
 *   harness's result is recorded after it settles.
 * - **a `tool.call` that cannot be written**: `beforeTool` throws, so nothing runs (fail closed).
 *   **a `tool.result` that cannot be written**: `afterTool` replaces the result with a failure (B1):
 *   pi-durable keeps the tool's result when a hook throws, so the failure has to be the result itself.
 */
function toolHooks(options: ToolHookOptions): ToolHooks {
  const { identityOf, sinks, env, memory, served } = options;
  // The granted path is chosen per call from the hook's own identity: the tool task carries the
  // conversation it runs in, and the run's grant goes to that conversation, never to the workspace.
  const grantsOf = (api: HookApi): WorkspaceGrants | undefined =>
    options.grants?.(runIdentityOf(sinks.auditIdentity, api));
  const specFor = (callId: string, identity: ToolIdentity, context: Context): ToolCallSpec => ({
    identity,
    callId,
    env,
    context,
    sinks,
  });
  const callRecordOf = (callId: string, identity: ToolIdentity): CallRecord => ({
    identity,
    name: identity.definition.toolId,
    callId,
    sinks,
  });
  return {
    async beforeTool(call, _api, context) {
      const identity = await identityOf(call.name);
      const spec = specFor(call.id, identity, context);
      // The harness validated the call against pi-durable's schema and coerced it; admission parses the
      // arguments as the model's own schema sees them (a model's `timeout` reaches the strictObject and
      // is refused there, before anything is hashed or run).
      const model = modelArguments(identity.definition.toolId, call.arguments);
      const admission = await admitCall(spec, model);
      if (!admission.ok) {
        // The call does not run, and its refusal is the call's result: `afterTool` writes the
        // `tool.result` from the entry remembered here, so its decision (the denial's own code) is the
        // result's. Blocking gives the model the harness's own refusal, in words.
        memory.set(call.id, {
          call: undefined,
          decision: admission.decision,
          startedAt: Date.now(),
        });
        return { block: refusalWording(admission.decision) };
      }
      const admitted = admission.admitted;
      const path = grantsOf(_api);
      if (path === undefined) {
        memory.set(call.id, {
          call: admitted.call,
          decision: admitted.decision,
          startedAt: Date.now(),
        });
        return {
          arguments: harnessArguments(admitted.args, identity.definition.toolId),
        };
      }
      // The granted path: the machine decides and runs the call, and its decision is the one the
      // result is recorded under. A refusal blocks here exactly as an admission refusal does.
      const granted = await grantedCall(path, admitted.call, identity);
      served.set(call.id, granted.served);
      memory.set(call.id, {
        call: admitted.call,
        decision: granted.decision,
        startedAt: Date.now(),
        served: granted.served,
      });
      if (granted.block !== undefined) return { block: granted.block };
      return {
        arguments: harnessArguments(admitted.args, identity.definition.toolId),
      };
    },
    async afterTool(call, result) {
      const identity = await identityOf(call.name);
      const record = callRecordOf(call.id, identity);
      const known = memory.get(call.id);
      memory.delete(call.id);
      const decision =
        known?.decision ??
        // pi-durable refused the arguments before `beforeTool`: no `tool.call` names the call, and its
        // result is still recorded. (Not `tool_disabled`: that means the tool is off, not that the
        // arguments were not a call.)
        phase0Deny(INVALID_ARGUMENTS, "the arguments were refused before the tool ran");
      const durationMs = known === undefined ? 0 : Date.now() - known.startedAt;
      try {
        await appendEvent(record, known?.call, decision, "tool.result", {
          ok: succeeded(result),
          durationMs,
        });
        // The granted path: the registered tool returns the result the machine produced (it ran
        // nothing here), so this is the one that is committed.
        return known?.served;
      } catch (caught) {
        // A caught value is unknown by definition; the message is the one thing worth reading.
        const error = caught instanceof Error ? caught : new Error(String(caught));
        // pi-durable turns a hook's throw into an `extension_error` and keeps the tool's own result, so
        // a `tool.result` that could not be recorded is delivered as a failure result instead: the
        // model does not read an output whose row is missing (fail closed, `docs/capability.md` §8).
        const failed = failureReply({
          ok: false,
          status: "failed",
          code: "audit_unavailable",
          message: "the result of this call could not be recorded, so it is not returned",
        });
        // The hook API has no diagnostic channel of its own; the reason rides on the result it commits,
        // where the UI reads `diagnostics` and the model reads the message.
        return {
          ...failed,
          diagnostics: [
            {
              severity: "error" as const,
              message: "the tool result could not be recorded: " + errorMessage(error),
              code: "audit_unavailable",
            },
          ],
        };
      }
    },
  };
}

/**
 * One call on the granted path: ask for a grant, relay the call, and read the machine's decision.
 *
 * @returns The decision the result is recorded under, what the tool returns (the machine's result,
 * or the refusal), and the wording to block with when the call may not run.
 *
 * @remarks
 * The order is the contract's: the grant is asked for (cached per tool × manifest × machine), then
 * the call is relayed with it and the current policy, and **nothing runs here**. A call the machine
 * refused is recorded under the machine's own code (`scope_exceeded`, `grant_expired`,
 * `grant_revoked`, `counter_exhausted`, ...), which is the audit's vocabulary; the model reads the
 * harness's error ({@link refusalWording}) and the run continues, exactly as an admission refusal
 * does (the (A) contract).
 *
 * A grant that cannot be obtained, or a relay that fails, is **not** a policy answer: the call is
 * denied as `grant_invalid` (no grant, no run — fail closed) and the model reads the same refusal
 * shape.
 */
async function grantedCall(
  grants: WorkspaceGrants,
  call: CallIdentity,
  identity: ToolIdentity,
): Promise<{
  readonly decision: PolicyDecision;
  readonly served: ToolExecutionResult;
  readonly block?: string | undefined;
}> {
  const contract: ToolContract = {
    manifest: identity.manifest,
    manifestHash: identity.manifestHash,
  };
  let refusal: PolicyDecision | undefined;
  let answer: Awaited<ReturnType<ToolTransport["call"]>> | undefined;
  try {
    const issued = await grants.source.issue(grantRequestFor(contract));
    if (!issued.ok) {
      // The policy's own answer: it is the decision the call is recorded under.
      refusal = issued.decision;
    } else {
      answer = await grants.transport.call({
        call: call.call,
        contract,
        // What this call counts against the grant's bytes: its share of the policy's budget, so a
        // grant pays for the calls it was issued for (see `grantCallBytes`).
        bytes: grantCallBytes(issued.grant),
        grant: issued.grant,
      });
    }
  } catch (error) {
    if (!(error instanceof GrantUnavailableError || error instanceof ToolTransportError))
      throw error;
    refusal =
      error instanceof GrantUnavailableError
        ? grantUnavailableDecision(error)
        : relayUnavailableDecision(error);
  }
  if (refusal !== undefined) {
    return {
      decision: refusal,
      served: failureReply({ ok: false, status: "denied", message: refusalDetail(refusal) }),
      block: refusalWording(refusal),
    };
  }
  if (answer === undefined) {
    throw new Error("a granted call answered neither a decision nor a result");
  }
  if (answer.decision.outcome === "deny") {
    return {
      decision: answer.decision,
      served: failureReply({
        ok: false,
        status: "denied",
        message: refusalDetail(answer.decision),
      }),
      block: refusalWording(answer.decision),
    };
  }
  // The machine allowed the call and answered the operation's result; the tool returns it.
  // The machine's answer is untrusted JSON until the operation's schema accepts it.
  const operation = v.safeParse(MachineToolResultSchema, answer.result);
  if (!operation.success) {
    const unreadable = failureReply({
      ok: false,
      status: "failed",
      code: "unreadable_answer",
      message: "the machine answered a result this tool cannot read",
    });
    return {
      decision: answer.decision,
      served: unreadable,
      block: refusalWording(answer.decision),
    };
  }
  const result = servedResult(identity.definition.toolId, operation.output);
  return { decision: answer.decision, served: result };
}

/** A decision's message, for the failure the model reads when it is blocked. */
function refusalDetail(decision: PolicyDecision): string {
  return decision.outcome === "deny" ? decision.message : "the call was not allowed";
}

/**
 * The harness's result for a call the machine ran, built from the machine's own answer.
 *
 * @param toolId - The tool the call named.
 * @param answer - The operation's result, as the machine answered it.
 * @param api - The executing tool's API, for the output channel the harness reads.
 * @returns The result the registered tool returns unchanged: the same envelope the Phase 0 path
 * produces, so the model's JSON (and `succeeded`'s reading of it) does not change.
 */
function servedResult(toolId: ToolId, result: MachineToolResult): ToolExecutionResult {
  // The kind the answer names is the tool's own: a read's answer for a write would be a result the
  // machine never produced for this call, so it is refused rather than read as one.
  if (result.kind !== KIND_OF_TOOL[toolId]) {
    return failureReply({
      ok: false,
      status: "failed",
      code: "unreadable_answer",
      message: "the machine answered another tool's result",
    });
  }
  if (result.kind === "read") {
    const content = Buffer.from(result.content, "base64").toString("utf8");
    const truncated = content.length > MAX_READ_CONTENT;
    return {
      output: text({
        ok: true,
        content: truncated ? content.slice(0, MAX_READ_CONTENT) : content,
        version: result.version,
        truncated,
        characters: content.length,
      }),
      isError: false,
    };
  }
  if (result.kind === "write") {
    const outcome = v.safeParse(MutationResultSchema, result.result);
    if (!outcome.success) {
      return failureReply({
        ok: false,
        status: "failed",
        code: "unreadable_answer",
        message: "the machine answered a write outcome this contract cannot read",
      });
    }
    return { output: text(outcome.output), isError: outcome.output.status !== "applied" };
  }
  // bash: pi-durable's shell result, delivered as the tool's own output and structured answer.
  return {
    output: [{ type: "text" as const, text: result.output }],
    structuredOutput: { output: result.output, truncated: false, exitCode: result.exitCode },
    isError: result.exitCode !== 0,
  };
}

/** The workspace's write outcome, as the machine relays it. */
const MutationResultSchema = v.variant("status", [
  v.object({
    status: v.literal("applied"),
    operationId: v.string(),
    version: v.pipe(v.string(), v.minLength(1)),
  }),
  v.object({
    status: v.literal("conflict"),
    operationId: v.string(),
    currentVersion: v.pipe(v.string(), v.minLength(1)),
  }),
  v.object({
    status: v.literal("unknown"),
    operationId: v.string(),
    reason: v.picklist(["crash", "io", "timeout"]),
  }),
]);

/** The kind of result each tool's operation produces. */
const KIND_OF_TOOL: Readonly<Record<ToolId, MachineToolResult["kind"]>> = {
  read_file: "read",
  write_file: "write",
  bash: "exec",
};

/** The machine's answer for the three workspace operations, as its schema reads it. */
type MachineToolResult = v.InferOutput<typeof MachineToolResultSchema>;

/** The machine's answer for the three workspace operations, parsed at this boundary. */
const MachineToolResultSchema = v.union([
  v.object({
    kind: v.literal("read"),
    content: v.string(),
    version: v.pipe(v.string(), v.minLength(1)),
    size: v.number(),
  }),
  v.object({
    kind: v.literal("write"),
    /** The workspace's own outcome, parsed by its schema below: the machine adds nothing to it. */
    // oxlint-disable-next-line anti-slop/no-unknown-type-aliases -- an operation's result is JSON.
    result: v.unknown(),
  }),
  v.object({
    kind: v.literal("exec"),
    exitCode: v.number(),
    output: v.string(),
  }),
]);

/** A caught value's message, without its stack. */
function errorMessage(error: Error): string {
  return error.message;
}

/**
 * The arguments a call's `beforeTool` hands the tool: what the call was hashed over, plus what
 * pi-durable's own tool needs from it.
 *
 * @param admitted - The arguments the call was hashed over (a normalized path, bash's envelope).
 * @param toolId - The tool they belong to.
 * @returns The arguments `execute` must receive.
 *
 * @remarks
 * For a filesystem tool the admitted arguments are what runs (a normalized path names the same file).
 * For bash, pi-durable's bash takes `timeout` in seconds, so the model's `timeoutMs` is converted here
 * and nowhere else; the seconds value is what runs, and the call's `argsHash` covers the milliseconds.
 */
function harnessArguments(admitted: ToolArguments, toolId: ToolId): JsonObject {
  if (toolId === "bash") {
    if (!isBashInput(admitted)) {
      throw new Error("a bash call was admitted without its command");
    }
    if (admitted.timeoutMs === undefined) return { command: admitted.command };
    return { command: admitted.command, timeout: admitted.timeoutMs / 1000 };
  }
  if (isWriteFileArguments(admitted)) {
    return {
      path: admitted.path,
      content: admitted.content,
      expectedVersion: admitted.expectedVersion,
    };
  }
  if (!isReadFileArguments(admitted)) {
    throw new Error("a filesystem tool was given bash's arguments");
  }
  return { path: admitted.path };
}

/** The model's arguments of one call, before the agent adds bash's envelope. */
type ModelArguments = ReadFileArguments | WriteFileArguments | BashInput;

function isBashInput(args: ModelArguments): args is BashInput {
  return "command" in args;
}

function isReadFileArguments(args: ModelArguments): args is ReadFileArguments {
  return "path" in args;
}

/**
 * The model's arguments, recovered from what pi-durable validated.
 *
 * @param toolId - The tool's name.
 * @param args - What the hook receives: pi-durable's validated (and coerced) arguments.
 * @returns The arguments as the tool's own schema reads them: a filesystem call's strings, or bash's
 * `command` and whole `timeoutMs`.
 *
 * @remarks
 * pi-durable validates against the registration's JSON Schema with coercion, so what the hook sees is
 * the model's `timeoutMs` (an omitted one may arrive as `Infinity`). That value is dropped; the call
 * is hashed over the whole milliseconds the model wrote, never a fraction, because the contract's
 * canonical JSON holds safe integers only.
 */
function modelArguments(toolId: ToolId, args: ToolHookArguments): ModelArguments {
  return toolId === "bash" ? bashModelArguments(args) : fileModelArguments(args);
}

/**
 * The arguments a hook receives: the model's JSON after pi-durable's validation and coercion.
 *
 * @remarks
 * pi-durable's own `JsonObject` (its `ToolHookCall.arguments`), so reading one is not an open
 * dictionary: the tool's schema is what gives each member its meaning.
 */
type ToolHookArguments = Parameters<NonNullable<ToolHooks["beforeTool"]>>[0]["arguments"];

/** A filesystem call's string members, as the harness validated them. */
function fileModelArguments(args: ToolHookArguments): ModelArguments {
  const parsed = v.safeParse(FileArgumentsSchema, args);
  if (!parsed.success) throw new Error("a filesystem call arrived without its strings");
  return parsed.output;
}

/**
 * The model's own bash arguments: `command` and `timeoutMs` (whole milliseconds).
 *
 * @remarks
 * A `timeout` (seconds) is not this tool's argument. When one arrives it is passed through as written
 * so the tool's strict schema refuses it (a second name for the same value would let a fraction in
 * under a vocabulary the model was never offered), and a refusal is a value, not a throw.
 */
function bashModelArguments(args: ToolHookArguments): ModelArguments {
  const parsed = v.safeParse(BashHarnessSchema, args);
  if (!parsed.success) throw new Error("a bash call arrived without its command");
  const whole: ModelArguments = { command: parsed.output.command };
  // A `timeout` (seconds) is not this tool's argument: it is passed through so the tool's strictObject
  // refuses it, as a value. Every other key pi-durable coerced into its own schema is not the model's.
  if ("timeout" in args) {
    // SAFETY: the extra member is not a `BashInput`; it is carried for `admitCall` to refuse as an
    // unknown key, which is the value path the model reads. `ModelArguments` names the admitted shapes.
    return { ...whole, timeout: args["timeout"] } as ModelArguments & { readonly timeout: unknown };
  }
  if (parsed.output.timeoutMs === undefined) return whole;
  return { command: parsed.output.command, timeoutMs: Math.round(parsed.output.timeoutMs) };
}

/** A filesystem call as pi-durable validated it: the tool's three string members and no others. */
const FileArgumentsSchema = v.object({
  path: v.string(),
  content: v.optional(v.string()),
  expectedVersion: v.optional(v.string()),
});

/** A bash call as pi-durable validated it: its command and the model's whole milliseconds. */
const BashHarnessSchema = v.object({
  command: v.string(),
  timeoutMs: v.optional(v.number()),
});

/**
 * The arguments pi-durable's bash takes, after `beforeTool` converted them.
 *
 * @remarks
 * `harnessArguments` hands the tool seconds, not milliseconds, so this schema is what its
 * `execute` receives; the tool re-validates them because a hook's return value is not the model's
 * call, and the shell must never start on arguments nothing parsed.
 */
const BashExecuteSchema = v.object({
  command: v.string(),
  timeout: v.optional(v.number()),
});

/**
 * The line the model reads for a refused call: the harness's refusal, whose detail is this.
 *
 * @param decision - The refusal `admitCall` recorded.
 * @returns One fixed sentence per denial code, with no argument and no internal value in it.
 *
 * @remarks
 * The model's contract is the harness's error result (A); the denial's `code` is the audit's vocabulary
 * (`AuditEvent.decision`), and this sentence says the same thing in words a model can act on. The
 * failure face's code-to-status table is `docs/contracts/failures.md`; these are the tool face's
 * readings of the same denials.
 */
function refusalWording(decision: PolicyDecision): string {
  if (decision.outcome !== "deny") return "the call was not allowed";
  const wording: Record<DenialCode, string> = {
    policy_denied: "the policy does not allow this call",
    tool_disabled: "the tool is not enabled",
    scope_exceeded: "the call is outside the granted scope",
    manifest_mismatch: "the tool's contract does not match the one the call named",
    grant_invalid: "the grant is not valid",
    grant_expired: "the grant has expired",
    grant_revoked: "the grant was revoked before its expiry",
    grant_algorithm_mismatch: "the grant's key does not match its algorithm",
    grant_replayed: "the grant was already used",
    counter_exhausted: "the grant's budget is spent",
    epoch_stale: "the policy this was granted under has changed",
    path_outside_root: "the path is not inside the workspace root",
    command_not_allowed: "the command is not inside the exec envelope",
    egress_denied: "network egress is not granted",
    approval_stale: "the approval is for an older revision",
    unsupported: "the arguments are not a call this tool declares",
  };
  return wording[decision.code];
}

/**
 * The identity a hook's call runs under, with the run named by the tool task's conversation.
 *
 * @param identity - The wiring's identity: the workspace, the session, and the caller's defaults.
 * @param api - The executing tool's API, which names the tool task's conversation.
 * @returns The identity with `conversationId` set to the conversation the call runs in.
 *
 * @remarks
 * A run is a conversation's turn: the registry is shared by every conversation of the Session, so
 * the wiring's identity cannot carry a run of its own. The tool task does, at the moment its hook
 * runs, and that is the one the granted path issues for and the transport relays as.
 */
function runIdentityOf(
  identity: AuditIdentity | undefined,
  api: HookApi,
): AuditIdentity | undefined {
  if (identity === undefined) return undefined;
  return { ...identity, conversationId: conversationIdOf(api) };
}

/**
 * The conversation a tool task runs in.
 *
 * @param api - The executing tool's API: the tool task's own conversation is its `conversationId`.
 * @returns The conversation id.
 */
function conversationIdOf(api: HookApi): string {
  // `HookApi.conversationId` is pi-durable's ConversationId (a branded decimal string): a tool task
  // always runs in one conversation, so there is no "no conversation" branch to write.
  return String(api.conversationId);
}

/**
 * The tool id a name names.
 *
 * @throws Error when no workspace tool has that id; `definitionOf` is the table's check.
 */
function toolId(name: string): ToolId {
  if (name === "read_file" || name === "write_file" || name === "bash") return name;
  throw new Error("no workspace tool named " + name);
}

/**
 * The schema pi-durable validates bash's calls with, before and after `beforeTool`.
 *
 * @remarks
 * The model's vocabulary is the manifest's descriptor: `command` and `timeoutMs` (a whole number of
 * milliseconds). `timeout` is declared because pi-durable re-validates the arguments the hook hands
 * back with this same schema (`tool.js`), and `beforeTool` hands `execute` the admitted `timeoutMs`
 * in the seconds pi-durable's bash takes. A model that writes `timeout` never reaches this schema's
 * post-hook pass: a model's `timeout` is refused by admission's strictObject (see
 * `bashModelArguments`), before anything is hashed or run.
 */
function bashHarnessParameters(): JsonObject {
  return {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run" },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
        description: "The longest wait in milliseconds; omit to wait as the sandbox allows",
      },
      // What `beforeTool` hands the tool: the admitted `timeoutMs` in the seconds pi-durable's bash
      // takes. pi-durable re-validates the hook's arguments with this schema, so `timeout` must be
      // declared here; the model never writes it (the manifest's descriptor is `timeoutMs` alone), and
      // `beforeTool` refuses a call that does.
      timeout: { type: "number", minimum: 0, description: "The wait in seconds, from timeoutMs" },
    },
    required: ["command"],
    additionalProperties: false,
  };
}

/**
 * The tools an agent gets: the workspace with a version check, and bash only
 * when a sandbox is available. A refused call comes back as a result the model
 * can read, so one bad path does not lose the run.
 *
 * @param options - The workspace, the exec decision, the observation sink, and the audit sink.
 * @returns The extension registering read_file, write_file, and bash when sandboxed.
 *
 * @remarks
 * The tools are pi-durable's own registrations (`defineTool` and `createBashTool`); the extension's
 * tool-task hooks (`toolHooks`) admit every call (`admitCall`) before it runs — the tool's own strict
 * schema parses the arguments, a filesystem path is normalized and kept inside the root, the call and
 * the tool's manifest are hashed, and the Phase 0 decision is audited — and record the harness's
 * verdict as the `tool.result` before it is committed. The tool events carry `callId`, `callHash`,
 * `argsHash`, `manifestHash`, `decision`, and `durationMs`; the raw arguments never do.
 *
 * read_file returns JSON {ok, content, version, truncated, characters}, capped at
 * 32K characters; version and characters describe the whole file, so a truncated
 * read can still be written back. write_file requires expectedVersion ("absent" for
 * a new file) and derives operationId from the tool call id, not from the model's
 * arguments; a conflict or unknown outcome is returned as a value with isError set,
 * never thrown. There is no unsandboxed exec fallback: only "sandboxed" registers bash.
 */
export function workspaceTools(options: WorkspaceToolsOptions): Extension {
  const { workspace, shell, grants } = options;
  const sinks = sinksOf(options);
  const identityOf = identityLookup();
  const memory: CallMemory = new Map();
  // The served results are shared by the tools' `execute` and the hooks; the extension key is set
  // below, once the extension that owns both exists.
  const served: ServedMemory = new Map();
  // The extension the tools belong to, set once it exists: a tool that ran before then is a
  // wiring defect.
  let installed: Extension | undefined;
  const executing = (): Extension => {
    if (installed === undefined) {
      throw new Error("a workspace tool ran before its extension was installed");
    }
    return installed;
  };

  const readDefinition = definitionOf("read_file");
  const writeDefinition = definitionOf("write_file");
  const registrations: ToolRegistration[] = [
    defineTool({
      name: "read_file",
      description: readDefinition.description,
      parameters: obj({ path: str() }),
      // The tool bounds its own content; give the harness room so it does not cut the JSON.
      outputLimits: { ...readDefinition.outputLimits, retain: "head" },
      execute: async (args, api) => {
        const served = servedResultFor(executing(), api.callId);
        if (served !== undefined) return served;
        try {
          const result = await workspace.read(args.path);
          const truncated = result.content.length > MAX_READ_CONTENT;
          const content = truncated ? result.content.slice(0, MAX_READ_CONTENT) : result.content;
          return {
            output: text({
              ok: true,
              content,
              version: result.version,
              truncated,
              characters: result.content.length,
            }),
            isError: false,
          };
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          return failureReply(failureOf(error));
        }
      },
    }),
    defineTool({
      name: "write_file",
      description: writeDefinition.description,
      parameters: obj({ path: str(), content: str(), expectedVersion: str() }),
      execute: async (args, api) => {
        const served = servedResultFor(executing(), api.callId);
        if (served !== undefined) return served;
        try {
          // The idempotency key is the tool call, not something the model can repeat.
          const outcome = await workspace.write({
            path: args.path,
            content: args.content,
            expectedVersion: args.expectedVersion,
            operationId: operationIdFor(api.callId),
          });
          return { output: text(outcome), isError: outcome.status !== "applied" };
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          return failureReply(failureOf(error));
        }
      },
    }),
  ];
  if (shell.kind === "sandboxed") {
    const bash = createBashTool();
    // The manifest's arguments, not pi-durable's: the model writes `timeoutMs` (an integer), and
    // `harnessArguments` turns it into the seconds pi-durable's bash takes. The schema is closed, so an
    // unknown key is refused before anything runs.
    const parameters: typeof bash.parameters = bashHarnessParameters();
    const execute = bash.execute;
    registrations.push({
      ...bash,
      parameters,
      execute: async (args, api, context) => {
        // A granted bash call ran on its machine; pi-durable's bash would run it again here.
        const served = servedResultFor(executing(), api.callId);
        if (served !== undefined) return served;
        const parsed = v.safeParse(BashExecuteSchema, args);
        if (!parsed.success) {
          throw new Error("a bash call reached its tool without a command");
        }
        return await execute(parsed.output, api, context);
      },
    });
  }
  const hookOptions: ToolHookOptions = { identityOf, sinks, env: shell.env, memory, served };
  if (grants !== undefined) hookOptions.grants = grants;
  const extension: Extension = defineExtension({
    name: "hns-workspace",
    tools: registrations,
    hooks: [hook(ToolTask, toolHooks(hookOptions))],
  });
  installed = extension;
  servedResults.set(extension, served);
  // What `withAuditSink` needs to rebuild the hooks: the pieces the caller's closures hold.
  workspaceSpecs.set(extension, grants === undefined ? { shell } : { shell, grants });
  return extension;
}

/**
 * A tool-name-to-manifest lookup that computes each manifest once.
 *
 * @returns The lookup `toolHooks` takes.
 *
 * @remarks
 * It is per extension: a Session that rebuilds the hooks (`withAuditSink`) gets its own, so no hash is
 * shared across two registries.
 */
function identityLookup(): (name: string) => Promise<ToolIdentity> {
  const identities = new Map<string, ToolIdentity>();
  return async (name) => {
    const cached = identities.get(name);
    if (cached !== undefined) return cached;
    const built = await manifestFor(definitionOf(toolId(name)));
    identities.set(name, built);
    return built;
  };
}

/** What `withAuditSink` has to know about an extension to rebuild its hooks. */
interface WorkspaceSpec {
  readonly shell: ShellAccess;
  /** The granted path, when this extension was built with one. */
  readonly grants?: GrantPathOf | undefined;
}

/**
 * The extensions this module built, and the pieces of the caller's closures their hooks read.
 *
 * @remarks
 * A WeakMap so an extension that is dropped is collected with its entry, and so nothing outside this
 * module can make an extension look like one of ours.
 */
const workspaceSpecs = new WeakMap<Extension, WorkspaceSpec>();

/**
 * The workspace-tools extension as the one with these sinks and (optionally) this run's grants.
 *
 * @param extension - The extension `workspaceTools` returned.
 * @param sinks - The observation and audit sinks its hooks record to.
 * @param grantsFor - The granted path for the conversation a hook runs in; absent keeps Phase 0.
 * @returns A new extension with the same name, tools, and task, and hooks that use `sinks`.
 *
 * @remarks
 * The Session owns the audit sink (it is the object that stores the rows) while the caller of
 * `openSession` owns the tools' closures, so the session hands the sink in here rather than rebuilding
 * the extension: the workspace, the shell, and the env are unchanged, and only what the hooks write to
 * is. The call memory is fresh, which is what a new Session needs. A caller that does not hold an
 * extension this was made by should use `workspaceTools({ audit })` instead.
 */
export function withAuditSink(
  extension: Extension,
  sinks: CallSinks,
  grantsFor?: GrantPathOf | undefined,
): Extension {
  const spec = workspaceSpecs.get(extension);
  if (spec === undefined) {
    throw new Error("the extension does not register the workspace tools");
  }
  const identityOf = identityLookup();
  const served = servedResults.get(extension) ?? new Map<string, ToolExecutionResult>();
  // One call memory per rebuilt extension, as before: `beforeTool` writes it and `afterTool` reads it.
  const memory: CallMemory = new Map();
  // A hook runs in one conversation, and a conversation is one run: the granted path is chosen per
  // call from the identity the sinks name, so a run never spends another run's grant. Without a
  // chooser the extension's own grants (the Phase 0 `undefined`) are the answer.
  const grantsOf: GrantPathOf | undefined = grantsFor ?? spec.grants;
  const hooksOf = (): ToolHooks => {
    const options: ToolHookOptions = { identityOf, sinks, env: spec.shell.env, memory, served };
    if (grantsOf !== undefined) options.grants = grantsOf;
    return toolHooks(options);
  };
  // The tools keep their own extension's entry: their `execute` returns the result this extension's
  // hooks served, so both read one map. The rebuilt extension is the installed one.
  return defineExtension({
    name: extension.name,
    tools: extension.tools ?? [],
    hooks: [hook(ToolTask, hooksOf())],
  });
}

/**
 * The tool names this extension offers, for logs and tests.
 *
 * @param extension - An extension, such as the one workspaceTools returned.
 * @returns Its tool names in registration order; empty when it registers none.
 */
export function toolNames(extension: Extension): readonly string[] {
  return (extension.tools ?? []).map((tool) => tool.name);
}
