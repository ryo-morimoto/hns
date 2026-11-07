import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Workspace } from "@hns/workspace";
import { createNoExecEnv, createSandboxEnv, detectSandbox } from "@hns/workspace/sandbox";
import { openAgent } from "../src/index.ts";
import type { Agent, AgentEvent, ShellAccess } from "../src/index.ts";

type Faux = ReturnType<typeof fauxProvider>;

export interface Fixture {
  readonly agent: Agent;
  readonly workspace: Workspace;
  readonly root: string;
  readonly events: readonly AgentEvent[];
  readonly faux: Faux;
}

/** Detection spawns bwrap; one probe per test file is enough. */
let probe: ReturnType<typeof detectSandbox> | undefined;
export const sandboxStatus = (): ReturnType<typeof detectSandbox> => (probe ??= detectSandbox());

/** A real workspace and a real Durable harness, with only the model faked. */
export async function withAgent(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "hns-agent-"));
  const root = join(base, "root");
  await mkdir(root);
  const env = new NodeExecutionEnv({ cwd: root });
  const workspace = await Workspace.open({
    env,
    root,
    journalPath: join(base, "journal.json"),
    context: ctx,
    rooted: false,
  });
  await workspace.write({
    path: "a.txt",
    content: "v1",
    expectedVersion: "absent",
    operationId: "seed",
  });

  const status = await sandboxStatus();
  const shell: ShellAccess = status.available
    ? { kind: "sandboxed", env: createSandboxEnv(env, { root, bwrap: status.bwrap }) }
    : { kind: "disabled", env: createNoExecEnv(env, status), reason: status.reason };
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const events: AgentEvent[] = [];
  let turn = 0;
  const agent = await openAgent({
    storage: new MemoryStorage(),
    models,
    workspace,
    shell,
    model: { provider: "faux", modelId: "faux-1" },
    cwd: root,
    context: ctx,
    onEvent: (event) => events.push(event),
    newRequestId: () => {
      turn += 1;
      return "turn-" + turn;
    },
  });
  try {
    await run({ agent, workspace, root, events, faux });
  } finally {
    await agent.close();
    await workspace.close();
    await rm(base, { recursive: true, force: true });
  }
}

/** Text blocks of every tool result, which is what the model read. */
export function toolResults(entries: readonly EntryRecord[]): string[] {
  return entries
    .filter((entry) => entry.kind === "pi.tool-result")
    .flatMap((entry) =>
      (entry.model ?? []).flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.map((part) => (part.type === "text" ? part.text : ""))
          : [message.content],
      ),
    );
}
