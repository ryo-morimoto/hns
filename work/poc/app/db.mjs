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
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

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
    /** A run left running by a crash is not resumable yet. */
    reconcileRuns() {
      db.prepare("UPDATE workflow_runs SET status = 'interrupted', finished_at = ? WHERE status IN ('queued', 'running')").run(now());
      db.prepare("UPDATE workflow_nodes SET status = 'interrupted' WHERE status = 'running'").run();
    },

    registerConversation({ id, projectId, title }) {
      db.prepare("INSERT INTO conversations (id, project_id, title, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, title = excluded.title")
        .run(id, projectId, title, now());
      return row(db.prepare("SELECT * FROM conversations WHERE id = ?").get(id));
    },
  };
}