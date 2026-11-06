// M2.5: one conversation drives read / write / bash through Workspace and the sandbox.
import { mkdtemp, readFile, readdir, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { obj, str } from "@earendil-works/pi-schema";
import { LocalExecutionEnv, Connection, localDaemon } from "@earendil-works/pi-env";
import { Workspace } from "../workspace-core/workspace.mjs";
import { createSandboxEnv } from "../workspace-core/sandbox.mjs";

const BWRAP = process.env.BWRAP || "bwrap";
const sha = (text) => "sha256:" + createHash("sha256").update(text).digest("hex");
let pass = 0, fail = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };

const base = await mkdtemp(join(tmpdir(), "hns-conv-"));
const root = join(base, "root");
await mkdir(root);
const connection = new Connection({ command: [localDaemon()] });
const raw = new LocalExecutionEnv({ cwd: root, connection });
const sandbox = createSandboxEnv(raw, { root, bwrap: BWRAP });
const ws = await new Workspace({ env: raw, root, journalPath: join(base, "journal.json"), context: ctx }).open();
await ws.recover();

await ws.write({ path: "a.txt", content: "v1", expectedVersion: "absent", operationId: "setup" });
const v1 = sha("v1");

const tools = defineExtension({
  name: "workspace-tools",
  tools: [
    defineTool({
      name: "read_file",
      description: "Read a workspace file. Returns JSON {content, version}.",
      parameters: obj({ path: str() }),
      execute: async (args) => ({ output: [{ type: "text", text: JSON.stringify(await ws.read(args.path)) }] }),
    }),
    defineTool({
      name: "write_file",
      description: "Replace a workspace file. expectedVersion is the version from read_file, or 'absent'.",
      parameters: obj({ path: str(), content: str(), expectedVersion: str(), operationId: str() }),
      execute: async (args) => {
        const outcome = await ws.write(args);
        return { output: [{ type: "text", text: JSON.stringify(outcome) }] };
      },
    }),
    createBashTool(),
  ],
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(tools);
const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => sandbox }, ctx);
const conversation = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root } });

async function turn(label, responses) {
  faux.setResponses(responses);
  const submission = await conversation.submit({ type: "input", content: label, requestId: label }, ctx);
  const settled = await submission.wait(ctx);
  check(settled.status === "done", label + ": run done", JSON.stringify(settled).slice(0, 200));
}

// 1. read then guarded write
await turn("turn-1", [
  fauxAssistantMessage(fauxToolCall("read_file", { path: "a.txt" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("write_file", { path: "a.txt", content: "v2", expectedVersion: v1, operationId: "op-1" }), { stopReason: "toolUse" }),
  fauxAssistantMessage("updated"),
]);
check((await readFile(join(root, "a.txt"), "utf8")) === "v2", "turn-1: agent wrote through Workspace");

// 2. bash is sandboxed
await turn("turn-2", [
  fauxAssistantMessage(fauxToolCall("bash", { command: "echo inside > b.txt; echo escape > ../escape.txt" }), { stopReason: "toolUse" }),
  fauxAssistantMessage("done"),
]);
check((await readdir(root)).includes("b.txt"), "turn-2: bash wrote inside root");
check(!(await readdir(base)).includes("escape.txt"), "turn-2: bash could not escape");

// 3. stale write is refused
await turn("turn-3", [
  fauxAssistantMessage(fauxToolCall("write_file", { path: "a.txt", content: "stale", expectedVersion: v1, operationId: "op-2" }), { stopReason: "toolUse" }),
  fauxAssistantMessage("conflict seen"),
]);
check((await readFile(join(root, "a.txt"), "utf8")) === "v2", "turn-3: stale write did not apply");

// transcript and progress
const transcript = await conversation.entries({}, 40, undefined, ctx);
const toolResults = transcript.items.filter((entry) => entry.kind === "pi.tool-result");
check(toolResults.length === 4, "transcript has 4 tool results", String(toolResults.length));
const resultText = (entry) => entry.model?.[0]?.content?.[0]?.text ?? "";
const hasConflict = toolResults.some((entry) => { try { return JSON.parse(resultText(entry)).status === "conflict"; } catch { return false; } });
check(hasConflict, "conflict reached the model", toolResults.map(resultText).join(" | ").slice(0, 300));
const inspection = await harness.inspect(ctx);
check(inspection.tasks.filter((task) => task.status === "running" || task.status === "pending").length === 0, "no live tasks after the turns");

await harness.close(ctx);
await raw.cleanup?.(ctx);
await connection.close();
await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;