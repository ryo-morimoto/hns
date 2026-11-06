import type { Project, ProjectId, Task, TaskStatus } from "@hns/core";
import type { StoreContext } from "../db.ts";
import { parseProject, parseTask } from "../parse.ts";

export interface ProjectRepository {
  list(): Project[];
  get(id: ProjectId): Project | undefined;
  create(name: string): Project;
  rename(id: ProjectId, name: string): Project | undefined;
  delete(id: ProjectId): boolean;
  ensureDefault(): Project;
}

export interface TaskRepository {
  list(projectId?: ProjectId | undefined): Task[];
  get(id: string): Task | undefined;
  create(input: { projectId: ProjectId; title: string }): Task;
  update(
    id: string,
    patch: { title?: string | undefined; status?: TaskStatus | undefined },
  ): Task | undefined;
  delete(id: string): boolean;
}

// SAFETY: the brand exists only in the type; the default project id is fixed.
const DEFAULT_PROJECT_ID = "default" as ProjectId;

export function projectRepository(context: StoreContext): ProjectRepository {
  const { db, now, newId, transaction } = context;

  const get = (id: ProjectId): Project | undefined => {
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return row === undefined ? undefined : parseProject(row);
  };

  return {
    list: () =>
      db
        .prepare("SELECT * FROM projects ORDER BY created_at")
        .all()
        .map((row) => parseProject(row)),
    get,
    create(name) {
      const project = parseProject({ id: newId(), name, created_at: now() });
      transaction(() => {
        db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(
          project.id,
          project.name,
          project.created_at,
        );
      });
      return project;
    },
    rename(id, name) {
      transaction(() => {
        db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name, id);
      });
      return get(id);
    },
    delete(id) {
      return transaction(() => {
        const result = db.prepare("DELETE FROM projects WHERE id = ?").run(id);
        return Number(result.changes) > 0;
      });
    },
    ensureDefault() {
      const existing = get(DEFAULT_PROJECT_ID);
      if (existing !== undefined) return existing;
      const project = parseProject({ id: "default", name: "default", created_at: now() });
      transaction(() => {
        db.prepare("INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(
          project.id,
          project.name,
          project.created_at,
        );
      });
      const seeded = get(DEFAULT_PROJECT_ID);
      if (seeded === undefined) throw new Error("default project was not seeded");
      return seeded;
    },
  };
}

export function taskRepository(context: StoreContext): TaskRepository {
  const { db, now, newId, transaction } = context;

  const get = (id: string): Task | undefined => {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row === undefined ? undefined : parseTask(row);
  };

  return {
    list(projectId) {
      const rows =
        projectId === undefined
          ? db.prepare("SELECT * FROM tasks ORDER BY created_at").all()
          : db
              .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at")
              .all(projectId);
      return rows.map((row) => parseTask(row));
    },
    get,
    create(input) {
      const task = parseTask({
        id: newId(),
        project_id: input.projectId,
        title: input.title,
        status: "todo",
        created_at: now(),
        updated_at: now(),
      });
      transaction(() => {
        db.prepare(
          "INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(task.id, task.project_id, task.title, task.status, task.created_at, task.updated_at);
      });
      return task;
    },
    update(id, patch) {
      const current = get(id);
      if (current === undefined) return undefined;
      transaction(() => {
        db.prepare("UPDATE tasks SET title = ?, status = ?, updated_at = ? WHERE id = ?").run(
          patch.title ?? current.title,
          patch.status ?? current.status,
          now(),
          id,
        );
      });
      return get(id);
    },
    delete(id) {
      return transaction(() => {
        const result = db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
        return Number(result.changes) > 0;
      });
    },
  };
}
