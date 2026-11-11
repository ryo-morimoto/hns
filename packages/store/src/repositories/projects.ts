import type { Project, ProjectId, Task, TaskStatus } from "@hns/core";
import type { StoreContext } from "../db.ts";
import { parseProject, parseTask } from "../parse.ts";

/**
 * Projects: the top-level owner tasks, conversations, workflows, and automations point at.
 *
 * @remarks
 * A method that can miss returns `undefined` rather than throwing, and `delete` reports
 * whether a row was removed. A call that writes is one statement, so D1 commits it alone;
 * no method opens a transaction on behalf of another repository.
 */
export interface ProjectRepository {
  /** All projects, oldest first. */
  list(): Promise<Project[]>;
  /** The project with `id`, or `undefined` when it does not exist. */
  get(id: ProjectId): Promise<Project | undefined>;
  /** Create a project. The id and timestamp come from the store context. */
  create(name: string): Promise<Project>;
  /** Rename a project; `undefined` when it does not exist. */
  rename(id: ProjectId, name: string): Promise<Project | undefined>;
  /**
   * Delete a project.
   *
   * @remarks
   * Foreign keys cascade, so the project's tasks, conversations, workflows, and automations
   * go with it. Events and usage rows have no foreign key and stay.
   *
   * @returns Whether a row was deleted.
   */
  delete(id: ProjectId): Promise<boolean>;
  /**
   * Return the default project, creating it when it is missing.
   *
   * @remarks
   * `openStore` calls this, so an opened store always has one project. The id is fixed, so
   * calling this repeatedly is safe.
   */
  ensureDefault(): Promise<Project>;
}

/**
 * Tasks: the simple per-project work items.
 *
 * @remarks
 * Missing rows return `undefined`, `delete` reports whether a row was removed, and each
 * write is one statement.
 */
export interface TaskRepository {
  /** Tasks across every project, or only `projectId`; oldest first. */
  list(projectId?: ProjectId | undefined): Promise<Task[]>;
  /** The task with `id`, or `undefined` when it does not exist. */
  get(id: string): Promise<Task | undefined>;
  /** Create a task in `projectId`; a new task starts as `todo`. */
  create(input: { projectId: ProjectId; title: string }): Promise<Task>;
  /**
   * Update the given fields, keeping the rest.
   *
   * @remarks
   * `updated_at` moves to now on every update. `undefined` when the task does not exist.
   */
  update(
    id: string,
    patch: { title?: string | undefined; status?: TaskStatus | undefined },
  ): Promise<Task | undefined>;
  /** Delete a task; returns whether a row was removed. */
  delete(id: string): Promise<boolean>;
}

// SAFETY: the brand exists only in the type; the default project id is fixed.
const DEFAULT_PROJECT_ID = "default" as ProjectId;

/**
 * Build the project repository over `context`.
 *
 * @internal
 */
export function projectRepository(context: StoreContext): ProjectRepository {
  const { sql, now, newId } = context;

  const get = async (id: ProjectId): Promise<Project | undefined> => {
    const row = await sql.get("SELECT * FROM projects WHERE id = ?", [id]);
    return row === undefined ? undefined : parseProject(row);
  };

  return {
    async list() {
      const rows = await sql.all("SELECT * FROM projects ORDER BY created_at");
      return rows.map((row) => parseProject(row));
    },
    get,
    async create(name) {
      const project = parseProject({ id: newId(), name, created_at: now() });
      const row = await sql.get(
        "INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?) RETURNING *",
        [project.id, project.name, project.created_at],
      );
      if (row === undefined) throw new Error("project was not created");
      return parseProject(row);
    },
    async rename(id, name) {
      const row = await sql.get("UPDATE projects SET name = ? WHERE id = ? RETURNING *", [
        name,
        id,
      ]);
      return row === undefined ? undefined : parseProject(row);
    },
    async delete(id) {
      return (await sql.run("DELETE FROM projects WHERE id = ?", [id])) > 0;
    },
    async ensureDefault() {
      const existing = await get(DEFAULT_PROJECT_ID);
      if (existing !== undefined) return existing;
      const project = parseProject({ id: "default", name: "default", created_at: now() });
      const row = await sql.get(
        "INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(id) DO NOTHING RETURNING *",
        [project.id, project.name, project.created_at],
      );
      if (row !== undefined) return parseProject(row);
      const seeded = await get(DEFAULT_PROJECT_ID);
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
  const { sql, now, newId } = context;

  const get = async (id: string): Promise<Task | undefined> => {
    const row = await sql.get("SELECT * FROM tasks WHERE id = ?", [id]);
    return row === undefined ? undefined : parseTask(row);
  };

  return {
    async list(projectId) {
      const rows =
        projectId === undefined
          ? await sql.all("SELECT * FROM tasks ORDER BY created_at")
          : await sql.all("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at", [
              projectId,
            ]);
      return rows.map((row) => parseTask(row));
    },
    get,
    async create(input) {
      const task = parseTask({
        id: newId(),
        project_id: input.projectId,
        title: input.title,
        status: "todo",
        created_at: now(),
        updated_at: now(),
      });
      const row = await sql.get(
        "INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?) RETURNING *",
        [task.id, task.project_id, task.title, task.status, task.created_at, task.updated_at],
      );
      if (row === undefined) throw new Error("task was not created");
      return parseTask(row);
    },
    async update(id, patch) {
      const row = await sql.get(
        "UPDATE tasks SET title = COALESCE(?, title), status = COALESCE(?, status), " +
          "updated_at = ? WHERE id = ? RETURNING *",
        [patch.title ?? null, patch.status ?? null, now(), id],
      );
      return row === undefined ? undefined : parseTask(row);
    },
    async delete(id) {
      return (await sql.run("DELETE FROM tasks WHERE id = ?", [id])) > 0;
    },
  };
}
