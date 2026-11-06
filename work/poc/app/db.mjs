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
    registerConversation({ id, projectId, title }) {
      db.prepare("INSERT INTO conversations (id, project_id, title, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, title = excluded.title")
        .run(id, projectId, title, now());
      return row(db.prepare("SELECT * FROM conversations WHERE id = ?").get(id));
    },
  };
}
