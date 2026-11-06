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
import { openControlPlane } from "./db.mjs";
import { GraphError, interpolate, validateGraph } from "./workflow.mjs";
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
  const control = openControlPlane(join(stateDir, "control.sqlite"));
  control.reconcileRuns();
  const registry = createRegistry();
  registry.install(tools);
  const harness = await Harness.open(storage, { models, registry, env: () => sandbox }, ctx);
  const rootConversation = await harness.root(ctx, { agent: { model: { provider: providerId, modelId }, cwd: root } });
  control.registerConversation({ id: String(rootConversation.id), projectId: "default", title: "main" });
  harness.resume();

  const conversations = new Map([[String(rootConversation.id), rootConversation]]);
  const conversationById = async (id) => {
    if (!id) return rootConversation;
    const cached = conversations.get(String(id));
    if (cached) return cached;
    const found = await harness.conversation(Number(id), ctx);
    if (found) conversations.set(String(found.id), found);
    return found;
  };

  const lastAssistantText = async (conversation) => {
    const transcript = await conversation.entries({}, 20, undefined, ctx);
    const last = transcript.items.filter((entry) => entry.kind === "pi.assistant").at(-1);
    const content = last?.model?.[0]?.content ?? [];
    return Array.isArray(content) ? content.filter((block) => block.type === "text").map((block) => block.text).join("") : "";
  };

  const executeRun = async (runId) => {
    const run = control.getRun(runId);
    if (!run) return;
    let parsed;
    try { parsed = validateGraph(JSON.parse(run.graph_json)); }
    catch (error) { control.finishRun(runId, "failed", String(error?.message ?? error)); return; }
    const values = { input: run.input };
    control.setRunStatus(runId, "running");
    try {
      for (const id of parsed.order) {
        const node = parsed.nodes.find((candidate) => candidate.id === id);
        const prompt = interpolate(node.prompt, values);
        control.setNodeRunning(runId, id, prompt);
        const conversation = await harness.createConversation({
          ownership: { kind: "ownerless" },
          agent: { model: { provider: providerId, modelId }, cwd: root },
        }, ctx);
        const submission = await conversation.submit({ type: "input", content: prompt, requestId: `run-${runId}-${id}` }, ctx);
        const settled = await submission.wait(ctx);
        const text = settled.status === "done" ? await lastAssistantText(conversation) : "";
        values[id] = text;
        control.setNodeResult(runId, id, settled.status === "done" ? "done" : "failed", text, String(conversation.id));
        if (settled.status !== "done") throw new Error("node failed: " + id);
      }
      control.finishRun(runId, "done", JSON.stringify(values));
    } catch (error) {
      control.finishRun(runId, "failed", JSON.stringify({ error: String(error?.message ?? error), values }));
    }
  };

  const clients = new Set();
  const snapshot = async (conversation = rootConversation) => {
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
      conversations: control.listConversations(),
      projects: control.listProjects(),
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
  const watch = await rootConversation.watch(ctx);
  watch.start(async (call) => { if (call.kind === "value") broadcast(); });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/api/state" && req.method === "GET") {
        const conversation = await conversationById(url.searchParams.get("conversationId"));
        if (!conversation) return json(res, 404, { error: "conversation not found" });
        return json(res, 200, await snapshot(conversation));
      }
      if (url.pathname === "/api/projects") {
        if (req.method === "GET") return json(res, 200, control.listProjects());
        if (req.method === "POST") {
          const { name } = await bodyOf(req);
          if (!name) return json(res, 400, { error: "name is required" });
          return json(res, 201, control.createProject(name));
        }
      }
      if (url.pathname.startsWith("/api/projects/") && req.method === "PATCH") {
        const id = url.pathname.slice("/api/projects/".length);
        const { name } = await bodyOf(req);
        const project = control.renameProject(id, name);
        return project ? json(res, 200, project) : json(res, 404, { error: "project not found" });
      }
      if (url.pathname === "/api/tasks") {
        if (req.method === "GET") return json(res, 200, control.listTasks(url.searchParams.get("projectId") ?? undefined));
        if (req.method === "POST") {
          const body = await bodyOf(req);
          try { return json(res, 201, control.createTask({ projectId: body.projectId, title: body.title })); }
          catch (error) { return json(res, 400, { error: String(error.message ?? error) }); }
        }
      }
      if (url.pathname.startsWith("/api/tasks/") && req.method === "PATCH") {
        const id = url.pathname.slice("/api/tasks/".length);
        try {
          const task = control.updateTask(id, await bodyOf(req));
          return task ? json(res, 200, task) : json(res, 404, { error: "task not found" });
        } catch (error) { return json(res, 400, { error: String(error.message ?? error) }); }
      }
      if (url.pathname === "/api/workflows") {
        if (req.method === "GET") return json(res, 200, control.listWorkflows(url.searchParams.get("projectId") ?? undefined));
        if (req.method === "POST") {
          const { projectId = "default", name, graph } = await bodyOf(req);
          try { validateGraph(graph); }
          catch (error) { return json(res, 400, { error: String(error.message ?? error) }); }
          if (!name) return json(res, 400, { error: "name is required" });
          return json(res, 201, control.createWorkflow({ projectId, name, graph }));
        }
      }
      if (url.pathname.startsWith("/api/workflows/") && req.method === "PUT") {
        const id = url.pathname.slice("/api/workflows/".length);
        const { graph } = await bodyOf(req);
        try { validateGraph(graph); }
        catch (error) { return json(res, 400, { error: String(error.message ?? error) }); }
        const workflow = control.updateWorkflow(id, graph);
        return workflow ? json(res, 200, workflow) : json(res, 404, { error: "workflow not found" });
      }
      if (url.pathname.startsWith("/api/workflows/") && url.pathname.endsWith("/runs") && req.method === "POST") {
        const id = url.pathname.slice("/api/workflows/".length, -"/runs".length);
        const { input = "" } = await bodyOf(req);
        const run = control.createRun({ workflowId: id, input });
        if (!run) return json(res, 404, { error: "workflow not found" });
        void executeRun(run.id);
        return json(res, 202, { id: run.id, version: run.version });
      }
      if (url.pathname.startsWith("/api/runs/") && req.method === "GET") {
        const run = control.getRun(url.pathname.slice("/api/runs/".length));
        return run ? json(res, 200, run) : json(res, 404, { error: "run not found" });
      }
      if (url.pathname === "/api/runs" && req.method === "GET") {
        return json(res, 200, control.listRuns(url.searchParams.get("workflowId") ?? undefined));
      }
      if (url.pathname === "/api/conversations") {
        if (req.method === "GET") return json(res, 200, control.listConversations(url.searchParams.get("projectId") ?? undefined));
        if (req.method === "POST") {
          const { projectId = "default", title = "conversation" } = await bodyOf(req);
          const created = await harness.createConversation({
            ownership: { kind: "ownerless" },
            agent: { model: { provider: providerId, modelId }, cwd: root },
          }, ctx);
          conversations.set(String(created.id), created);
          return json(res, 201, control.registerConversation({ id: String(created.id), projectId, title }));
        }
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
        const { message, conversationId } = await bodyOf(req);
        const conversation = await conversationById(conversationId);
        if (!conversation) return json(res, 404, { error: "conversation not found" });
        const submission = await conversation.submit({ type: "input", content: message, requestId: "ui-" + Date.now() }, ctx);
        return json(res, 202, { requestId: submission.id, conversationId: String(conversation.id) });
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
      try { control.close(); } catch {}
      await raw.cleanup?.().catch(() => {});
      connection.close();
    },
  };
}