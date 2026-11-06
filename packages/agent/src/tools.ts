import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { obj, str } from "@earendil-works/pi-schema";
import type { MutationResult } from "@hns/core";
import type { Workspace } from "@hns/workspace";
import type { AgentEventSink } from "./events.ts";
import { failureOf } from "./failure.ts";
import type { ReadReply, ToolFailure } from "./failure.ts";
import type { ShellAccess } from "./shell.ts";

export interface WorkspaceToolsOptions {
  readonly workspace: Workspace;
  readonly shell: ShellAccess;
  readonly onEvent?: AgentEventSink | undefined;
}

const text = (
  value: ReadReply | ToolFailure | MutationResult,
): NonNullable<ToolExecutionResult["output"]> => [{ type: "text", text: JSON.stringify(value) }];

const failureReply = (failure: ToolFailure): ToolExecutionResult => ({
  output: text(failure),
  isError: true,
});

/** Emit tool.call and tool.result around one execution. */
async function observed(
  name: string,
  sink: AgentEventSink | undefined,
  work: () => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  const started = Date.now();
  sink?.({ event: "tool.call", at: new Date().toISOString(), tool: name });
  const result = await work();
  sink?.({
    event: "tool.result",
    at: new Date().toISOString(),
    tool: name,
    ok: result.isError !== true,
    ms: Date.now() - started,
  });
  return result;
}

/**
 * The tools an agent gets: the workspace with a version check, and bash only
 * when a sandbox is available. A refused call comes back as a value the model
 * can read, so one bad path does not lose the run.
 */
export function workspaceTools(options: WorkspaceToolsOptions): Extension {
  const { workspace, shell, onEvent } = options;
  const registrations: ToolRegistration[] = [
    defineTool({
      name: "read_file",
      description:
        "Read a workspace file. Returns JSON {ok, content, version} or {ok:false, status, message}.",
      parameters: obj({ path: str() }),
      execute: (args) =>
        observed("read_file", onEvent, async () => {
          try {
            const read = await workspace.read(args.path);
            return {
              output: text({ ok: true, content: read.content, version: read.version }),
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
      parameters: obj({ path: str(), content: str(), expectedVersion: str(), operationId: str() }),
      execute: (args) =>
        observed("write_file", onEvent, async () => {
          try {
            const outcome = await workspace.write({
              path: args.path,
              content: args.content,
              expectedVersion: args.expectedVersion,
              operationId: args.operationId,
            });
            return { output: text(outcome), isError: outcome.status !== "applied" };
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            return failureReply(failureOf(error));
          }
        }),
    }),
  ];
  if (shell.kind === "sandboxed") registrations.push(createBashTool());
  return defineExtension({ name: "hns-workspace", tools: registrations });
}

/** The tool names this extension offers, for logs and tests. */
export function toolNames(extension: Extension): readonly string[] {
  return (extension.tools ?? []).map((tool) => tool.name);
}
