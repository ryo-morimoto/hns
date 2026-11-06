// Abort while the delegate is working: durable child (B) vs pi-agent-core child (C).
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

async function setup(name) {
  const base = await mkdtemp(join(tmpdir(), "hns-ab-" + name + "-"));
  const root = join(base, "root");
  await mkdir(root);
  const env = new NodeExecutionEnv({ cwd: root });
  const workspace = await new Workspace({ env, root, journalPath: join(base, "journal.json"), context: ctx }).open();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { base, root, env, workspace, faux, models };
}

const kinds = (items) => items.map((entry) => entry.kind).join(",");

// B: the delegate runs a durable child conversation; both are aborted by one call.
async function durableInDurableAbort() {
  const s = await setup("b");
  const state = { sleepStarted: false, sawAbort: false, childSettlement: undefined };
  let markStarted;
  const started = new Promise((settle) => { markStarted = settle; });
  let harness;

  const sleepTool = defineTool({
    name: "sleep",
    description: "Wait until aborted.",
    parameters: obj({}),
    execute: async (_args, _api, context) => {
      markStarted();
      state.sleepStarted = true;
      await new Promise((settle) => {
        if (context.abortSignal === undefined) { settle(); return; }
        context.abortSignal.addEventListener("abort", () => { state.sawAbort = true; settle(); }, { once: true });
        setTimeout(settle, 3000);
      });
      return { output: [{ type: "text", text: "slept" }] };
    },
  });

  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "compare",
      tools: [
        sleepTool,
        defineTool({
          name: "delegate",
          description: "Run a child conversation.",
          parameters: obj({ task: str() }),
          execute: async (args, api, context) => {
            const child = await harness.createConversation(
              {
                ownership: { kind: "task", taskId: api.taskId },
                agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: s.root },
              },
              context,
            );
            const submission = await child.submit({ type: "input", content: args.task, requestId: "child-1" }, context);
            state.childId = child.id;
            const settled = await submission.wait(context);
            state.childSettlement = settled;
            const page = await child.entries({}, 50, undefined, context);
            return { output: [{ type: "text", text: "child done" }] };
          },
        }),
      ],
    }),
  );
  harness = await Harness.open(new MemoryStorage(), { models: s.models, registry, env: () => s.env }, ctx);
  const conversation = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: s.root } });
  s.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate", { task: "sleep" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("sleep", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("child answer"),
  ]);
  const submission = await conversation.submit({ type: "input", content: "delegate it", requestId: "ab-1" }, ctx);
  await Promise.race([started, new Promise((settle) => setTimeout(settle, 2000))]);
  await conversation.abort(ctx);
  const outer = await submission.wait(ctx);
  const outerEntries = (await conversation.entries({}, 50, undefined, ctx)).items;
  const child = state.childId === undefined ? undefined : await harness.conversation(state.childId, ctx);
  const childEntries = child === undefined ? [] : (await child.entries({}, 50, undefined, ctx)).items;
  const report = {
    scenario: "B. durable in durable",
    outerSettlement: JSON.stringify(outer),
    sleepSawAbort: state.sawAbort,
    childSettlement: state.childSettlement === undefined ? "none" : JSON.stringify(state.childSettlement),
    outerEntries: kinds(outerEntries),
    childEntries: kinds(childEntries),
  };
  await harness.close(ctx).catch(() => undefined);
  await s.workspace.close();
  await rm(s.base, { recursive: true, force: true });
  return report;
}

// C: the delegate runs an in-memory Agent; only our wiring stops it.
async function durableAgentCoreAbort() {
  const s = await setup("c");
  const state = { sleepStarted: false, sawAbort: false, innerAborted: false };
  let markStarted;
  const started = new Promise((settle) => { markStarted = settle; });

  const sleepTool = {
    name: "sleep",
    label: "Sleep",
    description: "Wait until aborted.",
    parameters: obj({}),
    execute: async (_id, _args, signal) => {
      markStarted();
      state.sleepStarted = true;
      await new Promise((settle) => {
        if (signal === undefined) { settle(); return; }
        signal.addEventListener("abort", () => { state.sawAbort = true; settle(); }, { once: true });
        setTimeout(settle, 3000);
      });
      return { content: [{ type: "text", text: "slept" }], details: {} };
    },
  };

  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "compare",
      tools: [
        defineTool({
          name: "delegate",
          description: "Run a nested agent-core agent.",
          parameters: obj({ task: str() }),
          execute: async (args, api, context) => {
            const inner = new Agent({
              initialState: { systemPrompt: "sys", model: api.models.getModel("faux", "faux-1"), tools: [sleepTool] },
              streamFn: api.models.streamSimple.bind(api.models),
            });
            const onAbort = () => { state.innerAborted = true; inner.abort(); };
            context.abortSignal?.addEventListener("abort", onAbort, { once: true });
            try {
              await inner.prompt(args.task);
              return { output: [{ type: "text", text: "inner done" }] };
            } finally {
              context.abortSignal?.removeEventListener("abort", onAbort);
            }
          },
        }),
      ],
    }),
  );
  const harness = await Harness.open(new MemoryStorage(), { models: s.models, registry, env: () => s.env }, ctx);
  const conversation = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: s.root } });
  s.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate", { task: "sleep" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("sleep", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("inner answer"),
  ]);
  const submission = await conversation.submit({ type: "input", content: "delegate it", requestId: "ac-1" }, ctx);
  await Promise.race([started, new Promise((settle) => setTimeout(settle, 2000))]);
  await conversation.abort(ctx);
  const outer = await submission.wait(ctx);
  const outerEntries = (await conversation.entries({}, 50, undefined, ctx)).items;
  const report = {
    scenario: "C. agent-core in durable",
    outerSettlement: JSON.stringify(outer),
    sleepSawAbort: state.sawAbort,
    innerAborted: state.innerAborted,
    outerEntries: kinds(outerEntries),
  };
  await harness.close(ctx).catch(() => undefined);
  await s.workspace.close();
  await rm(s.base, { recursive: true, force: true });
  return report;
}

for (const row of [await durableInDurableAbort(), await durableAgentCoreAbort()]) {
  console.log("---");
  for (const [key, value] of Object.entries(row)) console.log(key + ": " + String(value));
}
