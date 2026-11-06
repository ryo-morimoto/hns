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