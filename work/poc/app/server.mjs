// Integrated MVP: one process with the conversation, the workspace, and the UI.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj, str } from "@earendil-works/pi-schema";
import { LocalExecutionEnv, Connection, localDaemon } from "@earendil-works/pi-env";
import { Workspace } from "../workspace-core/workspace.mjs";
import { createSandboxEnv } from "../workspace-core/sandbox.mjs";
import { ollamaCloud, readOllamaKey } from "../conversation/ollama.mjs";
import { opencodeGo, readOpenCodeKey } from "../conversation/opencode.mjs";

const BWRAP = process.env.BWRAP ?? "/nix/store/mvj6y8k3xs35cj7kq937xi44q4hl3r93-bubblewrap-0.12.0/bin/bwrap";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };

const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const bodyOf = (req) => new Promise((resolve, reject) => {
  let text = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => (text += chunk));
  req.on("end", () => { try { resolve(text ? JSON.parse(text) : {}); } catch (error) { reject(error); } });
  req.on("error", reject);
});

function textOf(message) {
  if (typeof message?.content === "string") return message.content;
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function viewEntry(entry) {
  const message = entry.model?.[0];
  if (entry.kind === "pi.user") return { role: "user", text: textOf(message) };
  if (entry.kind === "pi.assistant") {
    const calls = (message?.content ?? []).filter((block) => block.type === "toolCall").map((block) => block.name);
    return { role: "assistant", text: textOf(message), toolCalls: calls };
  }
  if (entry.kind === "pi.tool-result") return { role: "tool", toolName: message?.toolName, text: textOf(message) };
  return undefined;
}

export async function startApp({ stateDir, root, provider = "faux", model, fauxScript, webDirs = [] }) {
  const connection = new Connection({ command: [localDaemon()] });
  const raw = new LocalExecutionEnv({ cwd: root, connection });
  const sandbox = createSandboxEnv(raw, { root, bwrap: BWRAP });
  const ws = await new Workspace({ env: raw, root, journalPath: join(stateDir, "journal.json"), context: ctx }).open();
  await ws.recover();

  const models = createModels();
  let providerId;
  if (provider === "faux") {
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    providerId = "faux";
    const script = (fauxScript ?? []).map((step) => step.text !== undefined
      ? fauxAssistantMessage(step.text)
      : fauxAssistantMessage(fauxToolCall(step.toolCall, step.arguments ?? {}), { stopReason: "toolUse" }));
    faux.setResponses(script);
  } else if (provider === "opencode") {
    const built = opencodeGo({ apiKey: readOpenCodeKey(), model: model ?? "deepseek-v4.1-flash" });
    models.setProvider(built.provider);
    providerId = "opencode-go";
  } else {
    const built = ollamaCloud({ apiKey: readOllamaKey(), model: model ?? "gpt-oss:120b" });
    models.setProvider(built.provider);
    providerId = "ollama-cloud";
  }
  const modelId = model ?? (provider === "faux" ? "faux-1" : provider === "opencode" ? "deepseek-v4.1-flash" : "gpt-oss:120b");

  const tools = defineExtension({
    name: "workspace-tools",
    tools: [
      defineTool({
        name: "slow_tool",
        description: "Do nothing for 1.5 seconds. For progress tests.",
        parameters: obj({}),
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          return { output: [{ type: "text", text: "slow done" }] };
        },
      }),
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

  const storage = await openNodeSqliteStorage(join(stateDir, "session.sqlite"));
  const registry = createRegistry();
  registry.install(tools);
  const harness = await Harness.open(storage, { models, registry, env: () => sandbox }, ctx);
  const conversation = await harness.root(ctx, { agent: { model: { provider: providerId, modelId }, cwd: root } });
  harness.resume();

  const clients = new Set();
  const snapshot = async () => {
    const transcript = await conversation.entries({}, 100, undefined, ctx);
    const messages = transcript.items.map(viewEntry).filter(Boolean);
    const inspection = await harness.inspect(ctx);
    const tasks = (inspection.tasks ?? []).map((task) => ({
      id: String(task.record.id),
      kind: task.record.kind,
      state: task.state.kind,
    }));
    return {
      messages,
      tasks,
      queued: (inspection.submissions ?? []).length,
      scheduling: inspection.scheduling,
      provider: providerId,
      model: modelId,
    };
  };
  let pending = false;
  const broadcast = () => {
    if (pending) return;
    pending = true;
    setTimeout(async () => {
      pending = false;
      if (clients.size === 0) return;
      const data = JSON.stringify(await snapshot());
      for (const client of clients) client.write(`event: state\ndata: ${data}\n\n`);
    }, 30);
  };
  const watch = await conversation.watch(ctx);
  watch.start(async (call) => { if (call.kind === "value") broadcast(); });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/api/state" && req.method === "GET") {
        return json(res, 200, await snapshot());
      }
      if (url.pathname === "/api/stream" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        clients.add(res);
        res.write(`event: state\ndata: ${JSON.stringify(await snapshot())}\n\n`);
        const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
        req.on("close", () => { clearInterval(heartbeat); clients.delete(res); });
        return;
      }
      if (url.pathname === "/api/chat" && req.method === "POST") {
        const { message } = await bodyOf(req);
        const submission = await conversation.submit({ type: "input", content: message, requestId: "ui-" + Date.now() }, ctx);
        return json(res, 202, { requestId: submission.id });
      }
      if (url.pathname === "/api/files" && req.method === "GET") {
        const listing = await raw.listFiles(url.searchParams.get("path") ?? ".", { hidden: false, exclude: [".hns", ".hns-tmp-"] }, ctx);
        return json(res, listing.ok ? 200 : 400, listing.ok ? listing.value.entries : { error: listing.error.message });
      }
      if (url.pathname === "/api/file" && req.method === "GET") {
        try { return json(res, 200, await ws.read(url.searchParams.get("path"))); }
        catch (error) { return json(res, 404, { error: String(error?.message ?? error) }); }
      }
      if (url.pathname === "/api/file" && req.method === "PUT") {
        const outcome = await ws.write(await bodyOf(req));
        return json(res, outcome.status === "applied" ? 200 : outcome.status === "conflict" ? 409 : 202, outcome);
      }
      if (url.pathname.startsWith("/api/file") === false) {
        for (const webDir of webDirs) {
          const name = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
          if (name.includes("..")) continue;
          try {
            const body = await readFile(join(webDir, name));
            res.writeHead(200, { "content-type": MIME[extname(name)] ?? "application/octet-stream" });
            return res.end(body);
          } catch {}
        }
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      if (error?.name === "Denied" || error?.constructor?.name === "Denied") return json(res, 403, { error: error.message });
      return json(res, 500, { error: String(error?.message ?? error) });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: "http://127.0.0.1:" + port,
    close: async () => {
      await watch.stop().catch(() => {});
      for (const client of clients) client.end();
      clients.clear();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await Promise.race([harness.close(ctx).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3000))]);
      await Promise.race([storage.close?.() ?? Promise.resolve(), new Promise((resolve) => setTimeout(resolve, 2000))]);
      await raw.cleanup?.().catch(() => {});
      connection.close();
    },
  };
}