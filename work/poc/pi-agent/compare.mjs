// Compare three shapes for the same task:
//   A. pi-agent-core alone
//   B. pi-durable inside pi-durable (delegate creates an owned child conversation)
//   C. pi-agent-core inside pi-durable (delegate runs an in-memory Agent)
// Every shape reads a.txt, reports its version, and answers. Only the model is faked.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj, str } from "@earendil-works/pi-schema";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { Workspace } from "../workspace-core/workspace.mjs";

const TASK = "read a.txt and report its version";
const SYSTEM = "You are a coding agent inside a workspace.";
const RUNS = 3;

const textBlocks = (content) =>
  (Array.isArray(content) ? content : []).map((block) => (block.type === "text" ? block.text : "")).join("");

/** Newest assistant text of a Durable transcript (entry.kind). */
const durableAnswer = (items) => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const entry = items[index];
    if (entry?.kind !== "pi.assistant") continue;
    const text = textBlocks(entry.model?.[0]?.content);
    if (text !== "") return text;
  }
  return "";
};

/** Newest assistant text of a pi-agent-core transcript (message.role). */
const coreAnswer = (messages) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = textBlocks(message.content);
    if (text !== "") return text;
  }
  return "";
};

/** Tokens recorded by a Durable session: every conversation's buckets summed. */
const usageTokens = (state) => {
  let total = 0;
  for (const bucket of [...Object.values(state.models), ...Object.values(state.tools)]) {
    total += bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite;
  }
  return total;
};

/** One Usage object from a pi-agent-core transcript, for a tool result's `usage`. */
const sumUsage = (messages) => {
  const total = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const message of messages) {
    if (message.role !== "assistant" || message.usage === undefined) continue;
    total.input += message.usage.input;
    total.output += message.usage.output;
    total.cacheRead += message.usage.cacheRead;
    total.cacheWrite += message.usage.cacheWrite;
    total.totalTokens += message.usage.totalTokens;
    total.cost.input += message.usage.cost.input;
    total.cost.output += message.usage.cost.output;
    total.cost.cacheRead += message.usage.cost.cacheRead;
    total.cost.cacheWrite += message.usage.cost.cacheWrite;
    total.cost.total += message.usage.cost.total;
  }
  return total;
};

/** Model spend of a pi-agent-core transcript. */
const coreUsage = (messages) =>
  messages.reduce(
    (total, message) => (message.role === "assistant" && message.usage !== undefined ? total + message.usage.totalTokens : total),
    0,
  );

async function setup(name) {
  const base = await mkdtemp(join(tmpdir(), "hns-cmp-" + name + "-"));
  const root = join(base, "root");
  await mkdir(root);
  const env = new NodeExecutionEnv({ cwd: root });
  const workspace = await new Workspace({ env, root, journalPath: join(base, "journal.json"), context: ctx }).open();
  await workspace.write({ path: "a.txt", content: "v1", expectedVersion: "absent", operationId: "seed" });
  const version = (await workspace.read("a.txt")).version;

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const counted = { calls: 0 };
  const original = models.streamSimple.bind(models);
  models.streamSimple = (...args) => {
    counted.calls += 1;
    return original(...args);
  };
  return { base, root, env, workspace, version, faux, models, counted };
}

const coreTools = (workspace) => [
  {
    name: "read_file",
    label: "Read a file",
    description: "Read a workspace file.",
    parameters: obj({ path: str() }),
    execute: async (_id, args) => ({
      content: [{ type: "text", text: JSON.stringify(await workspace.read(args.path)) }],
      details: {},
    }),
  },
];

const durableRead = (workspace) =>
  defineTool({
    name: "read_file",
    description: "Read a workspace file.",
    parameters: obj({ path: str() }),
    execute: async (args) => ({ output: [{ type: "text", text: JSON.stringify(await workspace.read(args.path)) }] }),
  });

const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];

// A. pi-agent-core alone
async function scenarioAgentCore() {
  const times = [];
  let answer = "";
  let usage = 0;
  let history = "";
  for (let run = 0; run < RUNS; run += 1) {
    const s = await setup("a");
    const agent = new Agent({
      initialState: { systemPrompt: SYSTEM, model: s.models.getModel("faux", "faux-1"), tools: coreTools(s.workspace) },
      streamFn: s.models.streamSimple.bind(s.models),
    });
    s.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_file", { path: "a.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("version is " + s.version),
    ]);
    const started = Date.now();
    await agent.prompt(TASK);
    times.push(Date.now() - started);
    answer = coreAnswer(agent.state.messages);
    usage = coreUsage(agent.state.messages);
    history = String(agent.state.messages.length) + " messages";
    await s.workspace.close();
    await rm(s.base, { recursive: true, force: true });
  }
  return {
    scenario: "A. pi-agent-core only",
    modelCalls: 2,
    msMedian: median(times),
    answer,
    innerHistory: history + " (in memory; lost with the process)",
    persisted: "nothing",
    sessionTokens: String(usage) + " (only) ",
  };
}

// B. pi-durable inside pi-durable
async function scenarioDurableInDurable() {
  const times = [];
  let answer = "";
  let childEntries = 0;
  let childId;
  let tokens = 0;
  for (let run = 0; run < RUNS; run += 1) {
    const s = await setup("b");
    let harness;
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "compare",
        tools: [
          durableRead(s.workspace),
          defineTool({
            name: "delegate",
            description: "Ask a child conversation to do the task.",
            parameters: obj({ task: str() }),
            execute: async (args, api, context) => {
              const child = await harness.createConversation(
                {
                  ownership: { kind: "task", taskId: api.taskId },
                  agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: s.root },
                },
                context,
              );
              childId = child.id;
              const submission = await child.submit(
                { type: "input", content: args.task, requestId: "child-" + String(api.callId) },
                context,
              );
              await submission.wait(context);
              const page = await child.entries({}, 50, undefined, context);
              return { output: [{ type: "text", text: durableAnswer(page.items) }] };
            },
          }),
        ],
      }),
    );
    harness = await Harness.open(new MemoryStorage(), { models: s.models, registry, env: () => s.env }, ctx);
    const conversation = await harness.root(ctx, {
      agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: s.root },
    });
    s.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("delegate", { task: TASK }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read_file", { path: "a.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("inner: version is " + s.version),
      fauxAssistantMessage("outer: done"),
    ]);
    const started = Date.now();
    const submission = await conversation.submit({ type: "input", content: TASK, requestId: "b-" + String(run) }, ctx);
    await submission.wait(ctx);
    times.push(Date.now() - started);
    const outer = (await conversation.entries({}, 50, undefined, ctx)).items;
    answer = durableAnswer(outer);
    const child = childId === undefined ? undefined : await harness.conversation(childId, ctx);
    const entries = child === undefined ? [] : (await child.entries({}, 50, undefined, ctx)).items;
    childEntries = entries.length;
    tokens = usageTokens(await harness.usage(ctx));
    await harness.close(ctx).catch(() => undefined);
    await s.workspace.close();
    await rm(s.base, { recursive: true, force: true });
  }
  return {
    scenario: "B. durable in durable",
    modelCalls: 4,
    msMedian: median(times),
    answer,
    innerHistory: String(childEntries) + " entries (durable; child conversation " + String(childId) + ")",
    persisted: "both conversations, in Durable storage",
    sessionTokens: String(tokens) + " (outer + child summed)",
  };
}

// C. pi-agent-core inside pi-durable
async function scenarioDurableAgentCore() {
  const times = [];
  let answer = "";
  let innerMessages = 0;
  let tokens = 0;
  let innerTokens = 0;
  for (let run = 0; run < RUNS; run += 1) {
    const s = await setup("c");
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "compare",
        tools: [
          durableRead(s.workspace),
          defineTool({
            name: "delegate",
            description: "Run a nested pi-agent-core agent for the task.",
            parameters: obj({ task: str() }),
            execute: async (args, api, context) => {
              const inner = new Agent({
                initialState: {
                  systemPrompt: SYSTEM,
                  model: api.models.getModel("faux", "faux-1"),
                  tools: coreTools(s.workspace),
                },
                streamFn: api.models.streamSimple.bind(api.models),
              });
              const onAbort = () => inner.abort();
              context.abortSignal?.addEventListener("abort", onAbort, { once: true });
              try {
                await inner.prompt(args.task);
                innerMessages = inner.state.messages.length;
                innerTokens = coreUsage(inner.state.messages);
                return {
                  output: [{ type: "text", text: coreAnswer(inner.state.messages) }],
                  usage: sumUsage(inner.state.messages),
                };
              } finally {
                context.abortSignal?.removeEventListener("abort", onAbort);
              }
            },
          }),
        ],
      }),
    );
    const harness = await Harness.open(new MemoryStorage(), { models: s.models, registry, env: () => s.env }, ctx);
    const conversation = await harness.root(ctx, {
      agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: s.root },
    });
    s.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("delegate", { task: TASK }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read_file", { path: "a.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("inner: version is " + s.version),
      fauxAssistantMessage("outer: done"),
    ]);
    const started = Date.now();
    const submission = await conversation.submit({ type: "input", content: TASK, requestId: "c-" + String(run) }, ctx);
    await submission.wait(ctx);
    times.push(Date.now() - started);
    answer = durableAnswer((await conversation.entries({}, 50, undefined, ctx)).items);
    tokens = usageTokens(await harness.usage(ctx));
    await harness.close(ctx).catch(() => undefined);
    await s.workspace.close();
    await rm(s.base, { recursive: true, force: true });
  }
  return {
    scenario: "C. agent-core in durable",
    modelCalls: 4,
    msMedian: median(times),
    answer,
    innerHistory: String(innerMessages) + " messages (in memory; lost with the tool call)",
    persisted: "only the outer conversation",
    sessionTokens: String(tokens) + " (inner " + String(innerTokens) + " passed as tool usage)",
  };
}

const rows = [await scenarioAgentCore(), await scenarioDurableInDurable(), await scenarioDurableAgentCore()];
for (const row of rows) {
  console.log("---");
  for (const [key, value] of Object.entries(row)) console.log(key + ": " + String(value));
}