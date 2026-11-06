// Probe: can the agent be built on @earendil-works/pi-agent-core 1.5.0
// instead of pi-durable's Harness? Everything real except the model.
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj, str } from "@earendil-works/pi-schema";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Denied, Workspace } from "../workspace-core/workspace.mjs";
import { createSandboxEnv, detectSandbox } from "../workspace-core/sandbox.mjs";

let pass = 0, fail = 0;
const check = (ok, name, detail) => {
  if (ok) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, detail ?? ""); }
};

const base = await mkdtemp(join(tmpdir(), "hns-pi-agent-"));
const root = join(base, "root");
await mkdir(root);
const env = new NodeExecutionEnv({ cwd: root });
const workspace = await new Workspace({ env, root, journalPath: join(base, "journal.json"), context: ctx }).open();
await workspace.write({ path: "a.txt", content: "v1", expectedVersion: "absent", operationId: "seed" });
const version = (await workspace.read("a.txt")).version;

const sandboxStatus = await detectSandbox();
const sandbox = sandboxStatus.available ? createSandboxEnv(env, { root, bwrap: sandboxStatus.bwrap }) : undefined;

const text = (value) => [{ type: "text", text: JSON.stringify(value) }];

// The same workspace tools, as pi-agent-core declares them: pi-ai Tool + execute().
const tools = [
  {
    name: "read_file",
    label: "Read a file",
    description: "Read a workspace file. Returns JSON {content, version}.",
    parameters: obj({ path: str() }),
    execute: async (_toolCallId, args) => {
      try {
        const read = await workspace.read(args.path);
        return { content: text({ ok: true, content: read.content, version: read.version }), details: {} };
      } catch (error) {
        if (!(error instanceof Denied)) throw error;
        return { content: text({ ok: false, status: "denied", message: error.message }), details: {}, isError: true };
      }
    },
  },
  {
    name: "write_file",
    label: "Write a file",
    description: "Replace a workspace file. expectedVersion is the version from read_file, or 'absent'.",
    parameters: obj({ path: str(), content: str(), expectedVersion: str(), operationId: str() }),
    execute: async (_toolCallId, args) => {
      const outcome = await workspace.write(args);
      return { content: text(outcome), details: {}, isError: outcome.status !== "applied" };
    },
  },
];

if (sandbox !== undefined) {
  tools.push({
    name: "bash",
    label: "Run a command",
    description: "Run a shell command inside the sandboxed workspace root.",
    parameters: obj({ command: str() }),
    execute: async (_toolCallId, args) => {
      let output = "";
      const result = await sandbox.exec(["sh", "-c", args.command], {
        onOutput: (chunk) => { output += chunk; },
      }, ctx);
      if (!result.ok) return { content: text({ ok: false, status: "failed", message: result.error.message }), details: {}, isError: true };
      return { content: text({ ok: true, exitCode: result.value.exitCode, output }), details: {}, isError: result.value.exitCode !== 0 };
    },
  });
}

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = models.getModel("faux", "faux-1");
if (model === undefined) { console.error("no faux model"); process.exit(1); }

const events = [];
const agent = new Agent({
  initialState: { systemPrompt: "You are a coding agent inside a workspace.", model, tools },
  streamFn: models.streamSimple.bind(models),
});
agent.subscribe((event) => { events.push(event.type); });

// 1. read then guarded write
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("read_file", { path: "a.txt" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(
    fauxToolCall("write_file", { path: "a.txt", content: "v2", expectedVersion: version, operationId: "op-1" }),
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage("updated"),
]);
await agent.prompt("replace a.txt with v2");
check((await readFile(join(root, "a.txt"), "utf8")) === "v2", "pi-agent-core wrote through Workspace");

// 2. stale write is refused as a value
const stale = version;
faux.setResponses([
  fauxAssistantMessage(
    fauxToolCall("write_file", { path: "a.txt", content: "stale", expectedVersion: stale, operationId: "op-2" }),
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage("conflict seen"),
]);
await agent.prompt("write with a stale version");
check((await readFile(join(root, "a.txt"), "utf8")) === "v2", "stale write did not apply");

// 3. refusal reaches the model, not the run
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("read_file", { path: "../outside.txt" }), { stopReason: "toolUse" }),
  fauxAssistantMessage("denied"),
]);
await agent.prompt("read outside the root");
const toolResults = agent.state.messages.filter((message) => message.role === "toolResult");
const denied = toolResults.some((message) => JSON.stringify(message.content).includes('\\"status\\":\\"denied\\"'));
check(denied, "denied came back as a tool result", JSON.stringify(toolResults.at(-1)).slice(0, 200));
const conflicted = toolResults.some((message) => JSON.stringify(message.content).includes('\\"status\\":\\"conflict\\"'));
check(conflicted, "conflict came back as a tool result");

// 4. observation events
check(events.includes("agent_start") && events.includes("agent_end"), "agent lifecycle events", events.join(","));
check(events.some((type) => String(type).includes("tool")), "tool events", [...new Set(events)].join(","));

// 5. bash stays in the sandbox
if (sandbox === undefined) {
  console.log("SKIP bash containment:", sandboxStatus.reason);
} else {
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "echo inside > b.txt; echo escape > ../escape.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("ran it"),
  ]);
  await agent.prompt("prove the sandbox");
  check((await readdir(root)).includes("b.txt"), "bash wrote inside the root");
  check(!(await readdir(base)).includes("escape.txt"), "bash could not escape the root");
}

// 6. can the transcript be persisted and restored (the resume question)?
const saved = JSON.stringify(agent.state.messages);
const restoredModel = models.getModel("faux", "faux-1");
const restored = new Agent({
  initialState: { systemPrompt: "You are a coding agent inside a workspace.", model: restoredModel, tools, messages: JSON.parse(saved) },
  streamFn: models.streamSimple.bind(models),
});
check(restored.state.messages.length === agent.state.messages.length, "a transcript can be restored from JSON", String(restored.state.messages.length));
faux.setResponses([fauxAssistantMessage("still here")]);
await restored.prompt("what did you do?");
const lastAssistant = restored.state.messages.filter((message) => message.role === "assistant").at(-1);
check(JSON.stringify(lastAssistant).includes("still here"), "a restored agent answers", JSON.stringify(lastAssistant).slice(0, 160));

console.log("\nmessages:", agent.state.messages.length, "events:", [...new Set(events)].join(","));
console.log("pi-agent-core tools:", tools.map((tool) => tool.name).join(","));
await workspace.close();
await rm(base, { recursive: true, force: true });
// 7. both runtimes in one process, sharing one Models and one Workspace
{
  const { MemoryStorage, Harness, createRegistry, defineExtension, defineTool } = await import("@earendil-works/pi-durable");
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "probe-durable-tools",
      tools: [
        defineTool({
          name: "read_file",
          description: "Read a workspace file.",
          parameters: obj({ path: str() }),
          execute: async (args) => ({ output: [{ type: "text", text: JSON.stringify(await workspace.read(args.path)) }] }),
        }),
      ],
    }),
  );
  const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => env }, ctx);
  const conversation = await harness.root(ctx, {
    agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root },
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read_file", { path: "a.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("durable answer"),
  ]);
  const submission = await conversation.submit({ type: "input", content: "read it", requestId: "both-1" }, ctx);
  const settled = await submission.wait(ctx);
  check(settled.status === "done", "Durable Harness ran in the same process", JSON.stringify(settled).slice(0, 120));

  faux.setResponses([fauxAssistantMessage("agent-core answer")]);
  await agent.prompt("say something");
  const last = agent.state.messages.filter((message) => message.role === "assistant").at(-1);
  check(JSON.stringify(last).includes("agent-core answer"), "pi-agent-core ran beside it", JSON.stringify(last).slice(0, 120));
}

console.log("\n" + pass + "/" + (pass + fail) + " passed");
process.exitCode = fail ? 1 : 0;