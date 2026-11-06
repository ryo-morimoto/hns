import { randomUUID } from "node:crypto";
import type { createModels } from "@earendil-works/pi-ai/models";
import type { Context } from "@earendil-works/chord";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { Conversation, EntryRecord, Storage, Submission } from "@earendil-works/pi-durable";
import type { Workspace } from "@hns/workspace";
import type { AgentEvent, AgentEventSink } from "./events.ts";
import type { ShellAccess } from "./shell.ts";
import { toolNames, workspaceTools } from "./tools.ts";

export type Models = ReturnType<typeof createModels>;

/** Which provider and model the conversation runs on. */
export interface AgentModelRef {
  readonly provider: string;
  readonly modelId: string;
}

export interface AgentOptions {
  /** Where Durable keeps the conversation. MemoryStorage in tests; the store's storage in the app. */
  readonly storage: Storage;
  readonly models: Models;
  readonly workspace: Workspace;
  readonly shell: ShellAccess;
  readonly model: AgentModelRef;
  /** The agent's working directory, which must be inside the workspace root. */
  readonly cwd: string;
  readonly context: Context;
  readonly onEvent?: AgentEventSink | undefined;
  /** Deterministic request ids for tests; randomUUID in the app. */
  readonly newRequestId?: (() => string) | undefined;
}

/** What `Submission.wait()` settles with; Durable's own record, not a copy. */
export type Settlement = Awaited<ReturnType<Submission["wait"]>>;

/** One submitted turn, as Durable settled it, plus the text it answered with. */
export interface Turn {
  readonly settlement: Settlement;
  readonly text: string;
}

export interface Agent {
  readonly tools: readonly string[];
  send(input: string): Promise<Turn>;
  transcript(): Promise<readonly EntryRecord[]>;
  close(): Promise<void>;
}

/**
 * Compose the Durable harness for one conversation. Dependencies arrive here
 * and nowhere else, so a test can swap the model registry and the shell
 * (docs/typescript.md section 4); nothing connects at import time.
 */
export async function openAgent(options: AgentOptions): Promise<Agent> {
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

/** The text of the newest assistant entry that says something, which answers the turn. */
async function lastAssistantText(conversation: Conversation, context: Context): Promise<string> {
  const page = await conversation.entries({}, 200, undefined, context);
  const newestFirst = [...page.items].sort((left, right) => Number(right.id) - Number(left.id));
  for (const entry of newestFirst) {
    if (entry.kind !== "pi.assistant") continue;
    const text = textOf(entry);
    if (text !== "") return text;
  }
  return "";
}

function textOf(entry: EntryRecord): string {
  const message = entry.model?.[0];
  if (message === undefined) return "";
  const content = message.content;
  if (!Array.isArray(content)) return content;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}
