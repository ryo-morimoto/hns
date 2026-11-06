// Probe: what happens when the user aborts while a delegate (tool) is running?
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Workspace } from "../workspace-core/workspace.mjs";

const base = await mkdtemp(join(tmpdir(), "hns-abort-"));
const root = join(base, "root");
await mkdir(root);
const env = new NodeExecutionEnv({ cwd: root });
const workspace = await new Workspace({ env, root, journalPath: join(base, "journal.json"), context: ctx }).open();

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);

let markStarted;
const started = new Promise((settle) => { markStarted = settle; });
let release;
const gate = new Promise((settle) => { release = settle; });
const state = { signalSeen: false, toolReturned: false, returnedAfterAbort: false, abortedAt: 0 };

const registry = createRegistry();
registry.install(defineExtension({
  name: "probe",
  tools: [
    defineTool({
      name: "delegate",
      description: "Stands in for a nested pi-agent-core run.",
      parameters: obj({ task: str() }),
      execute: async (args, api, context) => {
        markStarted();
        api.output("delegate: started " + args.task + "\n");
        const onAbort = () => {
          state.signalSeen = true;
          state.abortedAt = Date.now();
          release();
        };
        context.abortSignal?.addEventListener("abort", onAbort, { once: true });
        try {
          await gate;
          api.output("delegate: finished after the abort signal\n");
          return { output: [{ type: "text", text: "delegate finished" }] };
        } finally {
          context.abortSignal?.removeEventListener("abort", onAbort);
          state.toolReturned = true;
          state.returnedAfterAbort = state.signalSeen;
        }
      },
    }),
  ],
}));

const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => env }, ctx);
const conversation = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root } });

faux.setResponses([
  fauxAssistantMessage(fauxToolCall("delegate", { task: "investigate" }), { stopReason: "toolUse" }),
  fauxAssistantMessage("outer answer"),
]);
const submission = await conversation.submit({ type: "input", content: "please delegate", requestId: "abort-1" }, ctx);
await started;
console.log("tool started");

const aborting = conversation.abort(ctx);
const settled = await Promise.race([
  submission.wait(ctx),
  new Promise((settle) => setTimeout(() => settle({ status: "timeout" }), 5000)),
]);
await Promise.race([aborting, new Promise((settle) => setTimeout(settle, 5000))]);

console.log("settled:", JSON.stringify(settled));
console.log("tool saw the abort signal:", state.signalSeen, "| tool returned:", state.toolReturned);
console.log("conversation idle after abort:", await conversation.entries({}, 1, undefined, ctx).then(() => true, () => false));

const entries = await conversation.entries({}, 20, undefined, ctx);
console.log("\ntranscript (newest first):");
for (const entry of entries.items) {
  const body = JSON.stringify(entry.model?.[0]?.content ?? entry.data ?? null);
  const diag = JSON.stringify(entry.data ?? null);
  console.log("-", entry.kind, body.slice(0, 160), diag === "null" ? "" : "data=" + diag.slice(0, 160));
}

await workspace.close();
await rm(base, { recursive: true, force: true });
