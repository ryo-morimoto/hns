import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { obj, str } from "@earendil-works/pi-schema";
import { operationIdFrom } from "@hns/core";
import type { MutationResult, OperationId } from "@hns/core";
import type { Workspace } from "@hns/workspace";
import * as v from "valibot";
import type { AgentEventSink } from "./events.ts";
import { failureOf } from "./failure.ts";
import type { ReadReply, ToolFailure } from "./failure.ts";
import type { ShellAccess } from "./shell.ts";

/** Model-facing read size, in characters. Worst-case JSON escaping is 6x, so 256 KiB covers it. */
const MAX_READ_CONTENT = 32 * 1024;

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
 * What workspaceTools needs: the workspace to expose, whether exec is offered, and
 * where observations go.
 */
export interface WorkspaceToolsOptions {
  readonly workspace: Workspace;
  /** Decides whether bash is registered; only "sandboxed" adds it. */
  readonly shell: ShellAccess;
  /** Receives tool.call and tool.result around each execution. */
  readonly onEvent?: AgentEventSink | undefined;
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
 * Whether the model should read a tool result as a failure.
 *
 * @param result - The tool's result, before the harness applies output limits.
 * @returns false when `isError` is true, or when a structured `exitCode` is nonzero.
 *
 * @remarks
 * `isError` is the general signal. bash also reports a nonzero exit as
 * `structuredOutput.exitCode`; reading both keeps `ok` true only for a command
 * that actually succeeded.
 */
function succeeded(result: ToolExecutionResult): boolean {
  if (result.isError === true) return false;
  const exitCode = exitCodeOf(result.structuredOutput);
  return exitCode === undefined || exitCode === 0;
}

/** The part of bash's structured output that decides success; other tools have none. */
const ExitCodeOutput = v.object({ exitCode: v.number() });

/**
 * The exit code a tool put in its structured output, when it has one.
 *
 * @param output - A tool's `structuredOutput`, which crosses the tool boundary as JSON.
 * @returns The numeric exit code, or undefined for tools that do not report one.
 *
 * @remarks
 * The value is parsed, not asserted: other tools return objects without an exit
 * code, and a future schema may change.
 */
function exitCodeOf(output: ToolExecutionResult["structuredOutput"]): number | undefined {
  const parsed = v.safeParse(ExitCodeOutput, output);
  return parsed.success ? parsed.output.exitCode : undefined;
}

/**
 * Emit tool.call and tool.result around one execution.
 *
 * @param name - The tool name as the model called it.
 * @param sink - Where the events go; undefined disables observation.
 * @param work - The execution to time; its result is returned unchanged.
 * @returns The execution's result.
 *
 * @remarks
 * `ms` covers only the awaited execution. A throwing `work` still emits
 * tool.result with `ok: false` before the throw propagates: bash reports a
 * timeout or an exec failure by throwing, and an unpaired call would hide it.
 */
async function observed(
  name: string,
  sink: AgentEventSink | undefined,
  work: () => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  const started = Date.now();
  sink?.({ event: "tool.call", at: new Date().toISOString(), tool: name });
  let ok = false;
  try {
    const result = await work();
    ok = succeeded(result);
    return result;
  } finally {
    sink?.({
      event: "tool.result",
      at: new Date().toISOString(),
      tool: name,
      ok,
      ms: Date.now() - started,
    });
  }
}

/**
 * The tools an agent gets: the workspace with a version check, and bash only
 * when a sandbox is available. A refused call comes back as a value the model
 * can read, so one bad path does not lose the run.
 *
 * @param options - The workspace, the exec decision, and the observation sink.
 * @returns The extension registering read_file, write_file, and bash when sandboxed.
 *
 * @remarks
 * read_file returns JSON {ok, content, version, truncated, characters}, capped at
 * 32K characters; version and characters describe the whole file, so a truncated
 * read can still be written back. write_file requires expectedVersion ("absent" for
 * a new file) and derives operationId from the tool call id, not from the model's
 * arguments; a conflict or unknown outcome is returned as a value with isError set,
 * never thrown. There is no unsandboxed exec fallback: only "sandboxed" registers bash.
 */
export function workspaceTools(options: WorkspaceToolsOptions): Extension {
  const { workspace, shell, onEvent } = options;
  const registrations: ToolRegistration[] = [
    defineTool({
      name: "read_file",
      description:
        "Read a workspace file. Returns JSON {ok, content, version} or {ok:false, status, message}.",
      parameters: obj({ path: str() }),
      // The tool bounds its own content; give the harness room so it does not cut the JSON.
      outputLimits: { maxBytes: 256 * 1024, maxLines: 40_000, retain: "head" },
      execute: (args) =>
        observed("read_file", onEvent, async () => {
          try {
            const read = await workspace.read(args.path);
            const truncated = read.content.length > MAX_READ_CONTENT;
            const content = truncated ? read.content.slice(0, MAX_READ_CONTENT) : read.content;
            return {
              output: text({
                ok: true,
                content,
                version: read.version,
                truncated,
                characters: read.content.length,
              }),
              isError: false,
            };
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            return failureReply(failureOf(error));
          }
        }),
    }),
    defineTool({
      name: "write_file",
      description:
        "Replace a workspace file. expectedVersion is the version from read_file, or 'absent'. Returns JSON " +
        "{status:'applied'|'conflict'|'unknown'} so a conflict can be re-read instead of retried blindly.",
      parameters: obj({ path: str(), content: str(), expectedVersion: str() }),
      execute: (args, api) =>
        observed("write_file", onEvent, async () => {
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
        }),
    }),
  ];
  if (shell.kind === "sandboxed") {
    const bash = createBashTool();
    // The harness sees the result through execute(); wrapping it here gives bash
    // the same call/result pair as the workspace tools.
    const execute: typeof bash.execute = (args, api, context) =>
      observed("bash", onEvent, async () => bash.execute(args, api, context));
    registrations.push({ ...bash, execute });
  }
  return defineExtension({ name: "hns-workspace", tools: registrations });
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
