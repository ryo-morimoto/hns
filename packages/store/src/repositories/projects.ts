import type { Project, ProjectId, Task, TaskStatus } from "@hns/core";
import type { StoreContext } from "../db.ts";
import { parseProject, parseTask } from "../parse.ts";

/**
 * Projects: the top-level owner tasks, conversations, workflows, and automations point at.
 *
 * @remarks
 * A method that can miss returns `undefined` rather than throwing, and `delete` reports
 * whether a row was removed. Each write runs in one transaction; no method opens a
 * transaction on behalf of another repository.
 */
export interface ProjectRepository {
  /** All projects, oldest first. */
  list(): Project[];
  /** The project with `id`, or `undefined` when it does not exist. */
  get(id: ProjectId): Project | undefined;
  /** Create a project. The id and timestamp come from the store context. */
  create(name: string): Project;
  /** Rename a project; `undefined` when it does not exist. */
  rename(id: ProjectId, name: string): Project | undefined;
  /**
   * Delete a project.
   *
   * @remarks
   * Foreign keys cascade, so the project's tasks, conversations, workflows, and automations
   * go with it. Events and usage rows have no foreign key and stay.
   *
   * @returns Whether a row was deleted.
   */
  delete(id: ProjectId): boolean;
  /**
   * Return the default project, creating it when it is missing.
   *
   * @remarks
   * `openStore` calls this, so an opened store always has one project. The id is fixed, so
   * calling this repeatedly is safe.
   */
  ensureDefault(): Project;
}

/**
 * Tasks: the simple per-project work items.
 *
 * @remarks
 * Missing rows return `undefined`, `delete` reports whether a row was removed, and each
 * write runs in one transaction.
 */
export interface TaskRepository {
  /** Tasks across every project, or only `projectId`; oldest first. */
  list(projectId?: ProjectId | undefined): Task[];
  /** The task with `id`, or `undefined` when it does not exist. */
  get(id: string): Task | undefined;
  /** Create a task in `projectId`; a new task starts as `todo`. */
  create(input: { projectId: ProjectId; title: string }): Task;
  /**
   * Update the given fields, keeping the rest.
   *
   * @remarks
   * `updated_at` moves to now on every update. `undefined` when the task does not exist.
   */
  update(
    id: string,
    patch: { title?: string | undefined; status?: TaskStatus | undefined },
  ): Task | undefined;
  /** Delete a task; returns whether a row was removed. */
  delete(id: string): boolean;
}

// SAFETY: the brand exists only in the type; the default project id is fixed.
const DEFAULT_PROJECT_ID = "default" as ProjectId;

/**
 * Build the project repository over `context`.
 *
 * @internal
 */
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

/**
 * Build the task repository over `context`.
 *
 * @internal
 */
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
