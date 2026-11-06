import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Workspace } from "@hns/workspace";
import { createNoExecEnv, createSandboxEnv, detectSandbox } from "@hns/workspace/sandbox";
import { Denied } from "@hns/workspace";
import { openAgent } from "../src/index.ts";
import type { Agent, AgentEvent, ShellAccess } from "../src/index.ts";

type Faux = ReturnType<typeof fauxProvider>;

interface Fixture {
  readonly agent: Agent;
  readonly workspace: Workspace;
  readonly root: string;
  readonly events: readonly AgentEvent[];
  readonly faux: Faux;
}

/** A real workspace and a real Durable harness, with only the model faked. */
async function withAgent(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "hns-agent-"));
  const root = join(base, "root");
  await mkdir(root);
  const env = new NodeExecutionEnv({ cwd: root });
  const workspace = await Workspace.open({
    env,
    root,
    journalPath: join(base, "journal.json"),
    context: ctx,
  });
  await workspace.write({
    path: "a.txt",
    content: "v1",
    expectedVersion: "absent",
    operationId: "seed",
  });

  const status = await detectSandbox();
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
function toolResults(entries: readonly EntryRecord[]): string[] {
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

test("a turn reads a file and replaces it with the version it read", async () => {
  await withAgent(async ({ agent, workspace, root, faux }) => {
    const version = (await workspace.read("a.txt")).version;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_file", { path: "a.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(
        fauxToolCall("write_file", {
          path: "a.txt",
          content: "v2",
          expectedVersion: version,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);

    const turn = await agent.send("replace the file");

    assert.equal(turn.settlement.status, "done");
    assert.equal(turn.text, "done");
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "v2");
  });
});

test("a write from a stale version comes back as a conflict value", async () => {
  await withAgent(async ({ agent, root, faux }) => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write_file", {
          path: "a.txt",
          content: "stale",
          expectedVersion: "sha256:old",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("conflict seen"),
    ]);

    const turn = await agent.send("write with a stale version");
    const results = toolResults(await agent.transcript());

    assert.equal(turn.settlement.status, "done");
    assert.ok(
      results.some((text) => text.includes('"status":"conflict"')),
      results.join(" | "),
    );
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "v1");
  });
});

// Catches: a refused path aborting the run instead of reaching the model as a value.
test("a refused path is reported to the model, not thrown", async () => {
  await withAgent(async ({ agent, faux }) => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_file", { path: "../outside.txt" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("denied"),
    ]);

    const turn = await agent.send("read outside the root");
    const results = toolResults(await agent.transcript());

    assert.equal(turn.settlement.status, "done");
    assert.ok(
      results.some((text) => text.includes('"status":"denied"')),
      results.join(" | "),
    );
  });
});

test("bash is offered only when a sandbox is available", async () => {
  const status = await detectSandbox();

  await withAgent(async ({ agent }) => {
    if (status.available) assert.ok(agent.tools.includes("bash"), agent.tools.join(","));
    else assert.equal(agent.tools.includes("bash"), false, agent.tools.join(","));
    assert.ok(agent.tools.includes("read_file"));
    assert.ok(agent.tools.includes("write_file"));
  });
});

test("observation events name the tool, its outcome, and the response", async () => {
  await withAgent(async ({ agent, events, faux }) => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_file", { path: "a.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("read it"),
    ]);

    await agent.send("read a.txt");

    const called = events.filter((event) => event.event === "tool.call");
    const finished = events.filter((event) => event.event === "tool.result");
    const answered = events.filter((event) => event.event === "agent.response");

    assert.equal(called.length, 1);
    assert.equal(called[0]?.event === "tool.call" ? called[0].tool : "", "read_file");
    assert.equal(finished[0]?.event === "tool.result" ? finished[0].ok : false, true);
    assert.equal(answered.length, 1);
    assert.equal(answered[0]?.event === "agent.response" ? answered[0].text : "", "read it");
  });
});

test("bash runs inside the root and cannot write outside it", async (t) => {
  const status = await detectSandbox();
  if (!status.available) {
    t.skip("bubblewrap is unavailable: " + status.reason);
    return;
  }
  await withAgent(async ({ agent, root, faux }) => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "echo inside > b.txt; echo escape > ../escape.txt" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("ran it"),
    ]);

    await agent.send("prove the sandbox");

    assert.equal((await readFile(join(root, "b.txt"), "utf8")).trim(), "inside");
    await assert.rejects(readFile(join(root, "..", "escape.txt"), "utf8"));
  });
});
// Catches: the model chose operationId, so repeating one silently swallowed the next write.
test("two writes in one turn both apply, because the call names the operation", async () => {
  await withAgent(async ({ agent, workspace, root, faux }) => {
    const first = (await workspace.read("a.txt")).version;
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write_file", { path: "a.txt", content: "v2", expectedVersion: first }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("read_file", { path: "a.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await agent.send("first write");
    const second = (await workspace.read("a.txt")).version;
    assert.notEqual(second, first);
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "v2");

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write_file", { path: "a.txt", content: "v3", expectedVersion: second }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    await agent.send("second write");

    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "v3");
  });
});

// Catches: read_file put the whole file in the model context (up to the 8 MiB workspace cap).
test("a large file is truncated in the tool result", async () => {
  await withAgent(async ({ agent, root, faux, workspace }) => {
    const big = "x".repeat(100 * 1024);
    await workspace.write({
      path: "big.txt",
      content: big,
      expectedVersion: "absent",
      operationId: "seed-big",
    });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_file", { path: "big.txt" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("read it"),
    ]);

    await agent.send("read the big file");
    const result = toolResults(await agent.transcript()).find((text) =>
      text.startsWith('{"ok":true'),
    );

    assert.ok(result !== undefined, "no read result");
    const parsed = JSON.parse(result);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.characters, big.length);
    assert.ok(parsed.content.length < big.length);
    assert.equal(await readFile(join(root, "big.txt"), "utf8"), big);
  });
});

// Catches: a cwd outside the root was accepted, so every relative tool path meant nothing.
test("a cwd outside the workspace root is refused", async () => {
  const base = await mkdtemp(join(tmpdir(), "hns-agent-cwd-"));
  const root = join(base, "root");
  await mkdir(root);
  const env = new NodeExecutionEnv({ cwd: root });
  const workspace = await Workspace.open({
    env,
    root,
    journalPath: join(base, "journal.json"),
    context: ctx,
  });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const status = await detectSandbox();
  const shell: ShellAccess = status.available
    ? { kind: "sandboxed", env: createSandboxEnv(env, { root, bwrap: status.bwrap }) }
    : { kind: "disabled", env: createNoExecEnv(env, status), reason: status.reason };
  try {
    await assert.rejects(
      openAgent({
        storage: new MemoryStorage(),
        models,
        workspace,
        shell,
        model: { provider: "faux", modelId: "faux-1" },
        cwd: base,
        context: ctx,
      }),
      Denied,
    );
  } finally {
    await workspace.close();
    await rm(base, { recursive: true, force: true });
  }
});
