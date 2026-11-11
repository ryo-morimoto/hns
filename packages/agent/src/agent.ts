import { randomUUID } from "node:crypto";
import type { createModels } from "@earendil-works/pi-ai/models";
import type { Context } from "@earendil-works/chord";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { EntryRecord, Storage } from "@earendil-works/pi-durable";
import { Denied } from "@hns/workspace";
import type { Workspace } from "@hns/workspace";
import type { AgentEvent, AgentEventSink } from "./events.ts";
import type { ShellAccess } from "./shell.ts";
import { toolNames, workspaceTools } from "./tools.ts";
import { lastAssistantText } from "./transcript.ts";
import type { Turn } from "./turn.ts";

export type { Turn } from "./turn.ts";

/** The pi-ai registry that resolves provider and model ids at request time. */
export type Models = ReturnType<typeof createModels>;

/** Which provider and model the conversation runs on. */
export interface AgentModelRef {
  /** The provider id, such as OLLAMA_PROVIDER or OPENCODE_PROVIDER. */
  readonly provider: string;
  /** The model id within that provider. */
  readonly modelId: string;
}

/**
 * Everything openAgent needs, assembled by the composition root.
 *
 * @remarks
 * A test substitutes the model registry and the shell here; nothing connects at
 * import time, so importing this module chooses neither a provider nor a sandbox.
 */
export interface AgentOptions {
  /** Where Durable keeps the conversation. MemoryStorage in tests; the store's storage in the app. */
  readonly storage: Storage;
  /** The registry that resolves `model`; a faux registry in tests. */
  readonly models: Models;
  /** The files the tools read and write, and the root `cwd` must stay inside. */
  readonly workspace: Workspace;
  /** Whether exec is offered; see ShellAccess. */
  readonly shell: ShellAccess;
  /** Which provider and model the conversation runs on. */
  readonly model: AgentModelRef;
  /** The agent's working directory, which must be inside the workspace root. */
  readonly cwd: string;
  /** The Durable context for every call: cancellation and tracing. */
  readonly context: Context;
  /** Receives tool and response observations; the server persists them. */
  readonly onEvent?: AgentEventSink | undefined;
  /** Deterministic request ids for tests; randomUUID in the app. */
  readonly newRequestId?: (() => string) | undefined;
}

/**
 * One open conversation: its tools, one turn at a time, its transcript, and close.
 *
 * @remarks
 * The agent belongs to one workspace and one cwd; every tool call resolves paths
 * against the workspace. A closed agent must not be used again.
 */
export interface Agent {
  /** The registered tool names; bash appears only when the shell is sandboxed. */
  readonly tools: readonly string[];
  /**
   * Submit one user turn and settle it.
   *
   * @param input - The user message text.
   * @returns The settlement and the newest assistant text ("" when none).
   * @throws Whatever Durable rejects the admission or the wait with; a settled
   * turn with no answer is a Turn, not an error.
   */
  send(input: string): Promise<Turn>;
  /**
   * The transcript Durable holds for this conversation.
   *
   * @returns Up to the newest 200 entries, newest first, as Durable recorded them.
   */
  transcript(): Promise<readonly EntryRecord[]>;
  /** Close the harness and release its resources; a closed agent must not be reused. */
  close(): Promise<void>;
}

/**
 * Compose the Durable harness for one conversation.
 *
 * @param options - The assembled dependencies, the model, and a cwd inside the workspace.
 * @returns An open agent; the caller owns it and must close it.
 * @throws Denied when `options.cwd` is not inside the workspace root.
 *
 * @remarks
 * Dependencies arrive here and nowhere else, so a test can swap the model registry
 * and the shell (docs/typescript.md section 4); nothing connects at import time.
 * The root is checked before the harness opens, so an outside cwd never reaches a
 * tool.
 */
export async function openAgent(options: AgentOptions): Promise<Agent> {
  // The agent works inside the workspace: a cwd outside it would make every relative tool path meaningless.
  if (!(await options.workspace.contains(options.cwd))) {
    throw new Denied("the agent cwd is outside the workspace root");
  }
  const extension = workspaceTools({
    workspace: options.workspace,
    shell: options.shell,
    onEvent: options.onEvent,
  });
  const registry = createRegistry();
  registry.install(extension);
  const harness = await Harness.open(
    options.storage,
    { models: options.models, registry, env: () => options.shell.env },
    options.context,
  );
  const conversation = await harness.root(options.context, {
    agent: { model: options.model, cwd: options.cwd },
  });

  const emit = (event: AgentEvent): void => options.onEvent?.(event);

  return {
    tools: toolNames(extension),
    async send(input: string): Promise<Turn> {
      const requestId = (options.newRequestId ?? randomUUID)();
      const submission = await conversation.submit(
        { type: "input", content: input, requestId },
        options.context,
      );
      const settlement = await submission.wait(options.context);
      const text = await lastAssistantText(conversation, options.context);
      emit({ event: "agent.response", at: new Date().toISOString(), text });
      return { settlement, text };
    },
    async transcript(): Promise<readonly EntryRecord[]> {
      const page = await conversation.entries({}, 200, undefined, options.context);
      return page.items;
    },
    async close(): Promise<void> {
      await harness.close(options.context);
    },
  };
}
