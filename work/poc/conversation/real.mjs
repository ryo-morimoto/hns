// One real conversation (Ollama Cloud or OpenCode Go), with the same tools as the faux run.
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { obj, str } from "@earendil-works/pi-schema";
import { LocalExecutionEnv, Connection, localDaemon } from "@earendil-works/pi-env";
import { Workspace } from "../workspace-core/workspace.mjs";
import { createSandboxEnv } from "../workspace-core/sandbox.mjs";
import { ollamaCloud, readOllamaKey } from "./ollama.mjs";
import { opencodeGo, readOpenCodeKey } from "./opencode.mjs";

const BWRAP = process.env.BWRAP ?? "/nix/store/mvj6y8k3xs35cj7kq937xi44q4hl3r93-bubblewrap-0.12.0/bin/bwrap";
const kind = process.env.PROVIDER ?? "ollama";
const model = process.env.MODEL_ID ?? (kind === "opencode" ? "deepseek-v4.1-flash" : "gpt-oss:120b");
const providerId = kind === "opencode" ? "opencode-go" : "ollama-cloud";
const key = kind === "opencode" ? readOpenCodeKey() : readOllamaKey();
if (!key) {
  console.error(`no key for ${kind}: write ~/.config/hns/${kind === "opencode" ? "opencode" : "ollama"}.key`);
  process.exit(2);
}

const base = await mkdtemp(join(tmpdir(), "hns-real-"));
const root = join(base, "root");
await mkdir(root);
const connection = new Connection({ command: [localDaemon()] });
const raw = new LocalExecutionEnv({ cwd: root, connection });
const sandbox = createSandboxEnv(raw, { root, bwrap: BWRAP });
const ws = await new Workspace({ env: raw, root, journalPath: join(base, "journal.json"), context: ctx }).open();
await ws.write({ path: "a.txt", content: "v1", expectedVersion: "absent", operationId: "setup" });

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
      execute: async (args) => ({ output: [{ type: "text", text: JSON.stringify(await ws.write(args)) }] }),
    }),
    createBashTool(),
  ],
});

const built = kind === "opencode" ? opencodeGo({ apiKey: key, model }) : ollamaCloud({ apiKey: key, model });
const models = createModels();
models.setProvider(built.provider);
const registry = createRegistry();
registry.install(tools);
const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => sandbox }, ctx);
const conversation = await harness.root(ctx, { agent: { model: { provider: providerId, modelId: model }, cwd: root } });

const started = Date.now();
const submission = await conversation.submit({
  type: "input",
  requestId: "real-1",
  content: "Read a.txt, then replace it with 'hello from ollama' using the version you read. Then say what you did.",
}, ctx);
const settled = await Promise.race([
  submission.wait(ctx),
  new Promise((resolve) => setTimeout(() => resolve({ status: "timeout" }), 180_000)),
]);
console.log("settled:", JSON.stringify(settled).slice(0, 400), "in", Date.now() - started, "ms");

const finalText = (await readFile(join(root, "a.txt"), "utf8")).trim();
console.log("file:", JSON.stringify(finalText));

const transcript = await conversation.entries({}, 60, undefined, ctx);
const kinds = transcript.items.map((entry) => entry.kind);
const toolResults = transcript.items.filter((entry) => entry.kind === "pi.tool-result");
const lastAssistant = transcript.items.filter((entry) => entry.kind === "pi.assistant").at(-1);
const textOf = (value) => JSON.stringify(value).slice(0, 200);
console.log("entries:", kinds.join(","));
console.log("tool results:", toolResults.length, toolResults.map((entry) => textOf(entry.model?.[0]?.content?.[0])).join(" | ").slice(0, 300));
console.log("answer:", lastAssistant ? textOf(lastAssistant.model?.[0]?.content) : "(none)");

const ok = finalText === "hello from ollama" && toolResults.length >= 2;
await Promise.race([harness.close(ctx).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))]);
await raw.cleanup?.(ctx).catch(() => {});
await Promise.race([connection.close(), new Promise((resolve) => setTimeout(resolve, 2000))]);
await rm(base, { recursive: true, force: true });
console.log(ok ? "OK" : "FAIL");
process.exit(ok ? 0 : 1);