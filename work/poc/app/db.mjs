// Control Plane data: projects, tasks, and which conversation belongs to which project.
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const TASK_STATUSES = ["todo", "doing", "done", "blocked"];

export function openControlPlane(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      graph_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      graph_json TEXT NOT NULL,
      status TEXT NOT NULL,
      input TEXT NOT NULL,
      output TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS workflow_nodes (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT,
      output TEXT,
      conversation_id TEXT,
      started_at TEXT,
      finished_at TEXT,
      PRIMARY KEY (run_id, node_id)
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      login TEXT NOT NULL UNIQUE,
      wrapped_dek TEXT,
      dek_iv TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      level TEXT NOT NULL,
      event TEXT NOT NULL,
      request_id TEXT,
      conversation_id TEXT,
      status INTEGER,
      duration_ms INTEGER,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS events_at ON events (at);
    CREATE TABLE IF NOT EXISTS usage_log (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      at TEXT NOT NULL,
      tokens INTEGER NOT NULL,
      cost REAL NOT NULL,
      request_id TEXT
    );
    CREATE TABLE IF NOT EXISTS user_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      credential_id TEXT,
      wrapped_dek TEXT NOT NULL,
      iv TEXT NOT NULL,
      salt TEXT,
      label TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS secrets (
      scope TEXT NOT NULL,
      name TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope, name)
    );
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      trigger_json TEXT NOT NULL,
      action_json TEXT NOT NULL,
      token TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_fired_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS firings (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      at TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      run_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const version = db.prepare("PRAGMA user_version").get().user_version ?? 0;
  // v1 databases predate the wrapped data key.
  if (version === 1) {
    for (const column of ["wrapped_dek", "dek_iv"]) {
      try { db.exec("ALTER TABLE users ADD COLUMN " + column + " TEXT"); } catch {}
    }
  }
  if (version < 2) db.exec("PRAGMA user_version = 2");
  if (version < 3) db.exec("PRAGMA user_version = 3");

  const now = () => new Date().toISOString();
  const row = (value) => (value === undefined ? undefined : { ...value });

  if (!db.prepare("SELECT id FROM projects LIMIT 1").get()) {
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run("default", "default", now());
  }

  return {
    close: () => db.close(),

    listProjects: () => db.prepare("SELECT * FROM projects ORDER BY created_at").all().map(row),
    getProject: (id) => row(db.prepare("SELECT * FROM projects WHERE id = ?").get(id)),
    createProject(name) {
      const project = { id: randomUUID(), name, created_at: now() };
      db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(project.id, project.name, project.created_at);
      return project;
    },
    renameProject(id, name) {
      db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name, id);
      return this.getProject(id);
    },

    listTasks(projectId) {
      const sql = projectId
        ? "SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at"
        : "SELECT * FROM tasks ORDER BY created_at";
      return (projectId ? db.prepare(sql).all(projectId) : db.prepare(sql).all()).map(row);
    },
    getTask: (id) => row(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id)),
    createTask({ projectId, title }) {
      if (!this.getProject(projectId)) throw new Error("project not found");
      const task = { id: randomUUID(), project_id: projectId, title, status: "todo", created_at: now(), updated_at: now() };
      db.prepare("INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(task.id, task.project_id, task.title, task.status, task.created_at, task.updated_at);
      return task;
    },
    updateTask(id, { title, status }) {
      if (status !== undefined && !TASK_STATUSES.includes(status)) throw new Error("invalid status");
      const current = this.getTask(id);
      if (!current) return undefined;
      db.prepare("UPDATE tasks SET title = ?, status = ?, updated_at = ? WHERE id = ?")
        .run(title ?? current.title, status ?? current.status, now(), id);
      return this.getTask(id);
    },

    listConversations(projectId) {
      const sql = projectId
        ? "SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at"
        : "SELECT * FROM conversations ORDER BY created_at";
      return (projectId ? db.prepare(sql).all(projectId) : db.prepare(sql).all()).map(row);
    },
    createWorkflow({ projectId, name, graph }) {
      const workflow = { id: randomUUID(), project_id: projectId, name, version: 1, graph_json: JSON.stringify(graph), created_at: now(), updated_at: now() };
      db.prepare("INSERT INTO workflows (id, project_id, name, version, graph_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(workflow.id, workflow.project_id, workflow.name, workflow.version, workflow.graph_json, workflow.created_at, workflow.updated_at);
      return workflow;
    },
    listWorkflows(projectId) {
      const sql = projectId
        ? "SELECT * FROM workflows WHERE project_id = ? ORDER BY created_at"
        : "SELECT * FROM workflows ORDER BY created_at";
      return (projectId ? db.prepare(sql).all(projectId) : db.prepare(sql).all()).map(row);
    },
    getWorkflow: (id) => row(db.prepare("SELECT * FROM workflows WHERE id = ?").get(id)),
    updateWorkflow(id, graph) {
      const current = this.getWorkflow(id);
      if (!current) return undefined;
      db.prepare("UPDATE workflows SET version = version + 1, graph_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(graph), now(), id);
      return this.getWorkflow(id);
    },
    createRun({ workflowId, input }) {
      const workflow = this.getWorkflow(workflowId);
      if (!workflow) return undefined;
      const run = { id: randomUUID(), workflow_id: workflowId, version: workflow.version, graph_json: workflow.graph_json, status: "queued", input, created_at: now() };
      db.prepare("INSERT INTO workflow_runs (id, workflow_id, version, graph_json, status, input, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(run.id, run.workflow_id, run.version, run.graph_json, run.status, run.input, run.created_at);
      const graph = JSON.parse(workflow.graph_json);
      for (const node of graph.nodes) {
        db.prepare("INSERT INTO workflow_nodes (run_id, node_id, status) VALUES (?, ?, 'pending')").run(run.id, node.id);
      }
      return run;
    },
    getRun(id) {
      const run = row(db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id));
      if (!run) return undefined;
      run.nodes = db.prepare("SELECT * FROM workflow_nodes WHERE run_id = ? ORDER BY rowid").all(id).map(row);
      return run;
    },
    listRuns(workflowId) {
      const rows = workflowId
        ? db.prepare("SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC").all(workflowId)
        : db.prepare("SELECT * FROM workflow_runs ORDER BY created_at DESC").all();
      return rows.map(row);
    },
    setRunStatus(id, status) {
      db.prepare("UPDATE workflow_runs SET status = ? WHERE id = ?").run(status, id);
    },
    finishRun(id, status, output) {
      db.prepare("UPDATE workflow_runs SET status = ?, output = ?, finished_at = ? WHERE id = ?").run(status, output ?? null, now(), id);
    },
    setNodeRunning(runId, nodeId, prompt) {
      db.prepare("UPDATE workflow_nodes SET status = 'running', prompt = ?, started_at = ? WHERE run_id = ? AND node_id = ?")
        .run(prompt, now(), runId, nodeId);
    },
    setNodeResult(runId, nodeId, status, output, conversationId) {
      db.prepare("UPDATE workflow_nodes SET status = ?, output = ?, conversation_id = ?, finished_at = ? WHERE run_id = ? AND node_id = ?")
        .run(status, output, conversationId ?? null, now(), runId, nodeId);
    },
    /** Runs a crash cut off: their running node goes back to pending and the runner picks it up again. */
    resumeRuns() {
      db.prepare("UPDATE workflow_nodes SET status = 'pending' WHERE status = 'running'").run();
      return db.prepare("SELECT * FROM workflow_runs WHERE status IN ('queued', 'running') ORDER BY created_at").all().map(row);
    },
    completeNode(runId, nodeId, output) {
      const node = db.prepare("SELECT * FROM workflow_nodes WHERE run_id = ? AND node_id = ?").get(runId, nodeId);
      if (!node || node.status !== "waiting") return undefined;
      db.prepare("UPDATE workflow_nodes SET status = 'done', output = ?, finished_at = ? WHERE run_id = ? AND node_id = ?")
        .run(output, now(), runId, nodeId);
      return row(db.prepare("SELECT * FROM workflow_nodes WHERE run_id = ? AND node_id = ?").get(runId, nodeId));
    },
    setNodeWaiting(runId, nodeId, prompt) {
      db.prepare("UPDATE workflow_nodes SET status = 'waiting', prompt = ?, started_at = ? WHERE run_id = ? AND node_id = ?")
        .run(prompt, now(), runId, nodeId);
    },

    getUserByLogin: (login) => row(db.prepare("SELECT * FROM users WHERE login = ?").get(login)),
    getUser: (id) => row(db.prepare("SELECT * FROM users WHERE id = ?").get(id)),
    createUser(login) {
      const user = { id: randomUUID(), login, created_at: now() };
      db.prepare("INSERT INTO users (id, login, created_at) VALUES (?, ?, ?)").run(user.id, user.login, user.created_at);
      return user;
    },
    addCredential({ id, userId, publicKey, counter, transports }) {
      db.prepare("INSERT INTO credentials (id, user_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, userId, publicKey, counter ?? 0, JSON.stringify(transports ?? []), now());
    },
    listCredentials(userId) {
      return db.prepare("SELECT * FROM credentials WHERE user_id = ?").all(userId).map(row);
    },
    getCredential: (id) => row(db.prepare("SELECT * FROM credentials WHERE id = ?").get(id)),
    updateCounter(id, counter) {
      db.prepare("UPDATE credentials SET counter = ? WHERE id = ?").run(counter, id);
    },
    addEvent({ level = "info", event, requestId, conversationId, status, durationMs, detail }) {
      db.prepare("INSERT INTO events (id, at, level, event, request_id, conversation_id, status, duration_ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), now(), level, event, requestId ?? null, conversationId ?? null, status ?? null, durationMs ?? null, detail === undefined ? null : JSON.stringify(detail));
    },
    listEvents({ limit = 100, level, since } = {}) {
      const clauses = [];
      const params = [];
      if (level) { clauses.push("level = ?"); params.push(level); }
      if (since) { clauses.push("at >= ?"); params.push(since); }
      const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
      return db.prepare("SELECT * FROM events" + where + " ORDER BY at DESC LIMIT ?").all(...params, Math.min(Number(limit) || 100, 1000)).map((entry) => {
        const event = row(entry);
        if (typeof event.detail === "string") { try { event.detail = JSON.parse(event.detail); } catch {} }
        return event;
      });
    },
    pruneEvents(days = 30) {
      const cutoff = new Date(Date.now() - days * 24 * 3600_000).toISOString();
      db.prepare("DELETE FROM events WHERE at < ?").run(cutoff);
    },
    metrics() {
      const since = new Date(Date.now() - 24 * 3600_000).toISOString();
      const byStatus = db.prepare("SELECT status, COUNT(*) AS count FROM events WHERE event = 'http' AND at >= ? GROUP BY status").all(since).map(row);
      const durations = db.prepare("SELECT duration_ms AS ms FROM events WHERE event = 'http' AND at >= ? AND duration_ms IS NOT NULL ORDER BY duration_ms").all(since).map((entry) => entry.ms);
      const percentile = (p) => durations.length === 0 ? 0 : durations[Math.min(durations.length - 1, Math.floor(durations.length * p))];
      const group = (table) => db.prepare("SELECT status, COUNT(*) AS count FROM " + table + " GROUP BY status").all().map(row);
      return {
        http: { total: durations.length, byStatus, p50ms: percentile(0.5), p95ms: percentile(0.95) },
        chats: Object.fromEntries(db.prepare("SELECT event, COUNT(*) AS count FROM events WHERE event IN ('chat.submitted', 'chat.settled') AND at >= ? GROUP BY event").all(since).map((row) => [row.event, row.count])),
        workflowRuns: group("workflow_runs"),
        firings: group("firings"),
        errors: db.prepare("SELECT COUNT(*) AS count FROM events WHERE level = 'error' AND at >= ?").get(since).count,
        toolCalls: db.prepare("SELECT COUNT(*) AS count FROM events WHERE event = 'tool.result' AND at >= ?").get(since).count,
        toolErrors: db.prepare("SELECT COUNT(*) AS count FROM events WHERE event = 'tool.result' AND level = 'warn' AND at >= ?").get(since).count,
        agentResponses: db.prepare("SELECT COUNT(*) AS count FROM events WHERE event = 'agent.response' AND at >= ?").get(since).count,
        byEvent: db.prepare("SELECT event, COUNT(*) AS count FROM events WHERE at >= ? GROUP BY event ORDER BY count DESC LIMIT 25").all(since).map(row),
        tokensToday: this.usageToday(),
      };
    },

    addUsage({ conversationId, tokens, cost, requestId }) {
      db.prepare("INSERT INTO usage_log (id, conversation_id, at, tokens, cost, request_id) VALUES (?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), conversationId ?? null, now(), Math.round(tokens), cost, requestId ?? null);
    },
    usageToday(date = new Date().toISOString().slice(0, 10)) {
      const row2 = db.prepare("SELECT COUNT(*) AS turns, COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost FROM usage_log WHERE substr(at, 1, 10) = ?").get(date);
      return { turns: Number(row2.turns), tokens: Number(row2.tokens), cost: Number(row2.cost) };
    },

    addUserKey({ userId, kind, credentialId, wrappedDek, iv, salt, label }) {
      const key = { id: randomUUID(), user_id: userId, kind, credential_id: credentialId ?? null, wrapped_dek: wrappedDek, iv, salt: salt ?? null, label: label ?? null, created_at: now() };
      db.prepare("INSERT INTO user_keys (id, user_id, kind, credential_id, wrapped_dek, iv, salt, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(key.id, key.user_id, key.kind, key.credential_id, key.wrapped_dek, key.iv, key.salt, key.label, key.created_at);
      return key;
    },
    listUserKeys(userId) {
      return db.prepare("SELECT * FROM user_keys WHERE user_id = ? ORDER BY created_at").all(userId).map(row);
    },
    setWrappedDek(userId, { wrappedDek, dekIv }) {
      db.prepare("UPDATE users SET wrapped_dek = ?, dek_iv = ? WHERE id = ?").run(wrappedDek, dekIv, userId);
    },
    getUserById: (id) => row(db.prepare("SELECT * FROM users WHERE id = ?").get(id)),

    createSession(userId, ttlMs) {
      const session = { id: randomUUID(), user_id: userId, expires_at: new Date(Date.now() + ttlMs).toISOString(), created_at: now() };
      db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(session.id, session.user_id, session.expires_at, session.created_at);
      return session;
    },
    getSession(id) {
      if (!id) return undefined;
      const session = row(db.prepare("SELECT * FROM sessions WHERE id = ?").get(id));
      if (!session) return undefined;
      if (new Date(session.expires_at).getTime() < Date.now()) { db.prepare("DELETE FROM sessions WHERE id = ?").run(id); return undefined; }
      return session;
    },
    deleteSession(id) { db.prepare("DELETE FROM sessions WHERE id = ?").run(id); },

    putSecret({ scope, name, ciphertext, iv, tag }) {
      db.prepare("INSERT INTO secrets (scope, name, ciphertext, iv, tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scope, name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at")
        .run(scope, name, ciphertext, iv, tag, now(), now());
    },
    getSecret(scope, name) {
      return row(db.prepare("SELECT * FROM secrets WHERE scope = ? AND name = ?").get(scope, name));
    },
    listSecretNames(scope) {
      return db.prepare("SELECT name, updated_at FROM secrets WHERE scope = ? ORDER BY name").all(scope).map(row);
    },
    deleteSecret(scope, name) {
      db.prepare("DELETE FROM secrets WHERE scope = ? AND name = ?").run(scope, name);
    },

    createAutomation({ projectId, name, trigger, action, enabled = true }) {
      if (!this.getProject(projectId)) throw new Error("project not found");
      if (trigger?.type === "webhook" && !trigger.token) trigger = { ...trigger, token: randomUUID().replaceAll("-", "") };
      const automation = {
        id: randomUUID(), project_id: projectId, name,
        trigger_json: JSON.stringify(trigger), action_json: JSON.stringify(action),
        token: trigger?.token ?? null, enabled: enabled ? 1 : 0,
        created_at: now(), updated_at: now(),
      };
      db.prepare("INSERT INTO automations (id, project_id, name, trigger_json, action_json, token, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(automation.id, automation.project_id, automation.name, automation.trigger_json, automation.action_json, automation.token, automation.enabled, automation.created_at, automation.updated_at);
      return this.getAutomation(automation.id);
    },
    getAutomation: (id) => row(db.prepare("SELECT * FROM automations WHERE id = ?").get(id)),
    getAutomationByToken: (token) => row(db.prepare("SELECT * FROM automations WHERE token = ?").get(token)),
    listAutomations(projectId) {
      const sql = projectId
        ? "SELECT * FROM automations WHERE project_id = ? ORDER BY created_at"
        : "SELECT * FROM automations ORDER BY created_at";
      return (projectId ? db.prepare(sql).all(projectId) : db.prepare(sql).all()).map(row);
    },
    updateAutomation(id, patch) {
      const current = this.getAutomation(id);
      if (!current) return undefined;
      db.prepare("UPDATE automations SET name = ?, enabled = ?, trigger_json = ?, action_json = ?, updated_at = ? WHERE id = ?")
        .run(patch.name ?? current.name, patch.enabled === undefined ? current.enabled : (patch.enabled ? 1 : 0),
          patch.trigger ? JSON.stringify(patch.trigger) : current.trigger_json,
          patch.action ? JSON.stringify(patch.action) : current.action_json, now(), id);
      return this.getAutomation(id);
    },
    setLastFiredAt(id, at) {
      db.prepare("UPDATE automations SET last_fired_at = ? WHERE id = ?").run(at, id);
    },
    createFiring({ automationId, at, status, detail, runId }) {
      const firing = { id: randomUUID(), automation_id: automationId, at, status, detail: detail ?? null, run_id: runId ?? null, created_at: now() };
      db.prepare("INSERT INTO firings (id, automation_id, at, status, detail, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(firing.id, firing.automation_id, firing.at, firing.status, firing.detail, firing.run_id, firing.created_at);
      return firing;
    },
    updateFiring(id, { status, detail, runId }) {
      db.prepare("UPDATE firings SET status = ?, detail = COALESCE(?, detail), run_id = COALESCE(?, run_id) WHERE id = ?")
        .run(status, detail ?? null, runId ?? null, id);
      return this.getFiring(id);
    },
    getFiring: (id) => row(db.prepare("SELECT * FROM firings WHERE id = ?").get(id)),
    listFirings(automationId) {
      return db.prepare("SELECT * FROM firings WHERE automation_id = ? ORDER BY created_at DESC").all(automationId).map(row);
    },

    registerConversation({ id, projectId, title }) {
      db.prepare("INSERT INTO conversations (id, project_id, title, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, title = excluded.title")
        .run(id, projectId, title, now());
      return row(db.prepare("SELECT * FROM conversations WHERE id = ?").get(id));
    },
  };
}