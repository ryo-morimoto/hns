// Integrated MVP: one process with the conversation, the workspace, and the UI.
import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
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
import { createTailscaleVerifier, parseUsers } from "./tailscale.mjs";
import { cronMatches } from "./cron.mjs";
import { GraphError, interpolate, validateGraph } from "./workflow.mjs";
import { Workspace } from "../workspace-core/workspace.mjs";
import { createSandboxEnv } from "../workspace-core/sandbox.mjs";
import { ollamaCloud, readOllamaKey } from "../conversation/ollama.mjs";
import { opencodeGo, readOpenCodeKey } from "../conversation/opencode.mjs";

const BWRAP = process.env.BWRAP ?? "/nix/store/mvj6y8k3xs35cj7kq937xi44q4hl3r93-bubblewrap-0.12.0/bin/bwrap";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };

const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

/** The app token: HNS_TOKEN, or a file in the state directory, generated once. */
async function resolveToken(stateDir) {
  if (process.env.HNS_TOKEN) return process.env.HNS_TOKEN.trim();
  const path = join(stateDir, "token");
  await mkdir(stateDir, { recursive: true }).catch(() => {});
  try { const existing = (await readFile(path, "utf8")).trim(); if (existing) return existing; } catch {}
  const token = randomUUID().replaceAll("-", "");
  await writeFile(path, token, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
  return token;
}

const same = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

function cookieOf(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}
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

export async function startApp({ stateDir, root, provider = "faux", model, fauxScript, webDirs = [], allowDebug = false, auth = true, host = process.env.HOST ?? "127.0.0.1", tailscale = {} }) {
  const token = await resolveToken(stateDir);
  const tailscaleMode = auth === "tailscale";
  const verifyTailscale = tailscaleMode
    ? createTailscaleVerifier({
        users: tailscale.users ?? parseUsers(process.env.HNS_TAILSCALE_USERS),
        allowLocal: tailscale.allowLocal ?? process.env.HNS_ALLOW_LOCAL === "1",
        whois: tailscale.whois,
      })
    : undefined;
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

  const activeRuns = new Set();
  const advance = async (runId) => {
    if (activeRuns.has(runId)) return;
    activeRuns.add(runId);
    try {
      const run = control.getRun(runId);
      if (!run || run.status === "done" || run.status === "failed" || run.status === "waiting") return;
      const parsed = validateGraph(JSON.parse(run.graph_json));
      const values = { input: run.input };
      for (const node of run.nodes) if (node.status === "done" && node.output !== null) values[node.node_id] = node.output;
      control.setRunStatus(runId, "running");

      for (const id of parsed.order) {
        const node = control.getRun(runId).nodes.find((candidate) => candidate.node_id === id);
        if (node.status === "done") continue;
        const definition = parsed.nodes.find((candidate) => candidate.id === id);
        const prompt = interpolate(definition.type === "tool" ? definition.command : definition.prompt, values);

        if (definition.type === "human") {
          control.setNodeWaiting(runId, id, prompt);
          control.setRunStatus(runId, "waiting");
          return;
        }
        control.setNodeRunning(runId, id, prompt);

        if (definition.type === "tool") {
          let output = "";
          const result = await sandbox.exec(prompt, { onOutput: (text) => { output += text; } }, ctx);
          const exitCode = result.ok ? result.value.exitCode : undefined;
          control.setNodeResult(runId, id, exitCode === 0 ? "done" : "failed", output);
          if (exitCode !== 0) throw new Error("tool node failed: " + id);
          values[id] = output;
          continue;
        }

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
      control.finishRun(runId, "failed", JSON.stringify({ error: String(error?.message ?? error) }));
    } finally {
      activeRuns.delete(runId);
    }
  };

  const runningAutomations = new Set();

  const runAction = async (automation, payload) => {
    const action = JSON.parse(automation.action_json);
    if (action.type === "task") {
      const task = control.createTask({ projectId: automation.project_id, title: action.title ?? automation.name });
      return { detail: "task " + task.id };
    }
    if (action.type === "chat") {
      const conversation = await conversationById(action.conversationId);
      if (!conversation) throw new Error("conversation not found");
      const content = action.prompt + (payload?.body ? "\n\n" + payload.body : "");
      const submission = await conversation.submit({ type: "input", content, requestId: "auto-" + Date.now() }, ctx);
      const settled = await submission.wait(ctx);
      return { detail: settled.status };
    }
    const run = control.createRun({ workflowId: action.workflowId, input: action.input ?? payload?.body ?? "" });
    if (!run) throw new Error("workflow not found");
    await advance(run.id);
    return { runId: run.id, detail: control.getRun(run.id).status };
  };

  const fire = async (automation, payload, origin) => {
    if (!automation.enabled) return { skipped: "disabled" };
    if (runningAutomations.has(automation.id)) {
      control.createFiring({ automationId: automation.id, at: new Date().toISOString(), status: "skipped", detail: "already running" });
      return { skipped: "already running" };
    }
    runningAutomations.add(automation.id);
    const firing = control.createFiring({ automationId: automation.id, at: new Date().toISOString(), status: "running", detail: origin });
    try {
      const result = await runAction(automation, payload);
      control.updateFiring(firing.id, { status: "done", detail: result.detail, runId: result.runId });
    } catch (error) {
      control.updateFiring(firing.id, { status: "failed", detail: String(error?.message ?? error) });
    } finally {
      runningAutomations.delete(automation.id);
    }
    return { firing: control.getFiring(firing.id) };
  };

  const tick = async (at = new Date()) => {
    const minute = at.toISOString().slice(0, 16);
    for (const automation of control.listAutomations()) {
      if (!automation.enabled) continue;
      const trigger = JSON.parse(automation.trigger_json);
      if (trigger.type !== "schedule") continue;
      let matches = false;
      try { matches = cronMatches(trigger.cron, at); } catch { continue; }
      if (!matches || automation.last_fired_at === minute) continue;
      control.setLastFiredAt(automation.id, minute);
      void fire(automation, {}, "schedule");
    }
  };
  const timer = setInterval(() => void tick(), 30_000);
  timer.unref?.();
  if (allowDebug) void tick();

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
  for (const run of control.resumeRuns()) void advance(run.id);

  const watch = await rootConversation.watch(ctx);
  watch.start(async (call) => { if (call.kind === "value") broadcast(); });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const isHook = url.pathname.startsWith("/api/hooks/");
      if (auth && url.pathname.startsWith("/api/") && !isHook) {
        if (tailscaleMode) {
          const verdict = await verifyTailscale(req.socket.remoteAddress);
          if (!verdict.ok) return json(res, 401, { error: "unauthorized", reason: verdict.reason });
        } else {
          const bearer = (req.headers.authorization ?? "").startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
          const candidate = bearer ?? url.searchParams.get("token") ?? cookieOf(req.headers.cookie, "hns_token");
          if (!same(candidate ?? "", token)) return json(res, 401, { error: "unauthorized" });
        }
      }
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
      if (url.pathname === "/api/automations") {
        if (req.method === "GET") return json(res, 200, control.listAutomations(url.searchParams.get("projectId") ?? undefined));
        if (req.method === "POST") {
          const { projectId = "default", name, trigger, action, enabled = true } = await bodyOf(req);
          if (!name || !trigger?.type || !action?.type) return json(res, 400, { error: "name, trigger, and action are required" });
          try { return json(res, 201, control.createAutomation({ projectId, name, trigger, action, enabled })); }
          catch (error) { return json(res, 400, { error: String(error.message ?? error) }); }
        }
      }
      if (url.pathname.startsWith("/api/automations/")) {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length === 3 && req.method === "PATCH") {
          const automation = control.updateAutomation(parts[2], await bodyOf(req));
          return automation ? json(res, 200, automation) : json(res, 404, { error: "automation not found" });
        }
        if (parts.length === 4 && parts[3] === "firings" && req.method === "GET") {
          return json(res, 200, control.listFirings(parts[2]));
        }
      }
      if (url.pathname.startsWith("/api/hooks/") && req.method === "POST") {
        const automation = control.getAutomationByToken(url.pathname.slice("/api/hooks/".length));
        if (!automation) return json(res, 404, { error: "unknown hook" });
        if (!automation.enabled) return json(res, 409, { error: "disabled" });
        const payload = await bodyOf(req).catch(() => ({}));
        const body = typeof payload.body === "string" ? payload.body : JSON.stringify(payload);
        void fire(automation, { body }, "webhook");
        return json(res, 202, { accepted: true });
      }
      if (allowDebug && url.pathname === "/api/debug/tick" && req.method === "POST") {
        const { at } = await bodyOf(req);
        await tick(at ? new Date(at) : new Date());
        return json(res, 200, { ok: true });
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
        void advance(run.id);
        return json(res, 202, { id: run.id, version: run.version });
      }
      if (url.pathname.startsWith("/api/runs/") && req.method === "POST") {
        const parts = url.pathname.split("/").filter(Boolean); // api, runs, <id>, nodes, <nodeId>
        if (parts.length === 5 && parts[3] === "nodes") {
          const runId = parts[2];
          const node = control.completeNode(runId, parts[4], (await bodyOf(req)).output ?? "");
          if (!node) return json(res, 404, { error: "waiting node not found" });
          control.setRunStatus(runId, "running");
          void advance(runId);
          return json(res, 202, { runId, node });
        }
        return json(res, 404, { error: "not found" });
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

  await new Promise((resolve) => server.listen(0, host, resolve));
  const { port } = server.address();
  return {
    url: "http://" + (host === "0.0.0.0" ? "127.0.0.1" : host) + ":" + port,
    token,
    close: async () => {
      clearInterval(timer);
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