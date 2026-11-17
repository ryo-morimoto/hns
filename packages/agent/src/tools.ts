import type { Context } from "@earendil-works/chord";
import { ToolTask } from "@earendil-works/pi-durable";
import { defineExtension, defineTool, hook } from "@earendil-works/pi-durable";
import type {
  Extension,
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
import type { DenialCode, PolicyDecision, ToolId } from "@hns/core/capability";
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
import type { ShellAccess } from "./shell.ts";

/** Model-facing read size, in characters. Worst-case JSON escaping is 6x, so 256 KiB covers it. */
const MAX_READ_CONTENT = 32 * 1024;

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
}

/**
 * One extension's calls, by the call id `beforeTool` admitted.
 *
 * @remarks
 * `beforeTool` writes an entry and `afterTool` reads and deletes it: a refused call's entry has no
 * `call`, and no entry at all means pi-durable refused the arguments before either hook ran.
 */
type CallMemory = Map<string, Admitted>;

/** What the tool hooks need: the tools, the sinks, the environment, and the call memory. */
interface ToolHookOptions {
  readonly identityOf: (name: string) => Promise<ToolIdentity>;
  readonly sinks: CallSinks;
  readonly env: ShellAccess["env"];
  readonly memory: CallMemory;
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
  const { identityOf, sinks, env, memory } = options;
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
      // The harness validated the call against pi-durable's schema and coerced it (an omitted number
      // may arrive as Infinity); admission parses the arguments as the model's own schema sees them.
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
      memory.set(call.id, {
        call: admission.admitted.call,
        decision: admission.admitted.decision,
        startedAt: Date.now(),
      });
      return {
        arguments: harnessArguments(admission.admitted.args, identity.definition.toolId),
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
        return undefined;
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
 * The tool id a name names.
 *
 * @throws Error when no workspace tool has that id; `definitionOf` is the table's check.
 */
function toolId(name: string): ToolId {
  if (name === "read_file" || name === "write_file" || name === "bash") return name;
  throw new Error("no workspace tool named " + name);
}

/**
 * The schema pi-durable validates bash's calls with.
 *
 * @remarks
 * The same vocabulary as the manifest's descriptor: `command` and `timeoutMs` (a whole number of
 * milliseconds), and nothing else. pi-durable's own bash takes `timeout` in seconds; the agent
 * converts the admitted `timeoutMs` as the arguments are handed to it (`harnessArguments`), so the
 * model's value is never re-read from a second name and a fraction is never rounded into a call.
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
  const { workspace, shell } = options;
  const sinks = sinksOf(options);
  const identities = new Map<string, ToolIdentity>();
  const identityOf = async (name: string): Promise<ToolIdentity> => {
    const cached = identities.get(name);
    if (cached !== undefined) return cached;
    const built = await manifestFor(definitionOf(toolId(name)));
    identities.set(name, built);
    return built;
  };
  const memory: CallMemory = new Map();

  const readDefinition = definitionOf("read_file");
  const writeDefinition = definitionOf("write_file");
  const registrations: ToolRegistration[] = [
    defineTool({
      name: "read_file",
      description: readDefinition.description,
      parameters: obj({ path: str() }),
      // The tool bounds its own content; give the harness room so it does not cut the JSON.
      outputLimits: { ...readDefinition.outputLimits, retain: "head" },
      execute: async (args) => {
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
    registrations.push({ ...bash, parameters });
  }
  return defineExtension({
    name: "hns-workspace",
    tools: registrations,
    hooks: [hook(ToolTask, toolHooks({ identityOf, sinks, env: shell.env, memory }))],
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
