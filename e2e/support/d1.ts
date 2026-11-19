import { DatabaseSync } from "node:sqlite";

/**
 * The control database a local edge reads: the project table, and nothing else.
 *
 * @param projectId - The one project (the one workspace) the journey opens documents in.
 * @param workspaceRoot - The project's directory below the machine's ROOT; empty is the ROOT.
 * @returns The database and its statement interface.
 *
 * @remarks
 * **The edge's own `storeFor` opens D1 through this shape** (the same `prepare/batch` the
 * Worker's binding has), so the journey runs the edge's real project lookup against a SQLite
 * file instead of a fake. Only the columns that lookup reads are created; a second table would
 * be a second contract this journey does not need.
 */
export interface ControlDatabase {
  readonly prepare: (query: string) => D1Statement;
  readonly batch: (statements: readonly D1Statement[]) => Promise<readonly D1Result[]>;
  readonly close: () => void;
}

interface D1Statement {
  bind(...values: readonly (string | number | null)[]): D1Statement;
  all(): Promise<{ readonly results: readonly Record<string, unknown>[] }>;
  first(): Promise<Record<string, unknown> | null>;
  run(): Promise<D1Result>;
}

interface D1Result {
  readonly meta: { readonly changes: number };
}

export function controlDatabase(projectId: string, workspaceRoot: string): ControlDatabase {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE IF NOT EXISTS projects (" +
      "id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_root TEXT NOT NULL DEFAULT '', " +
      "egress TEXT NOT NULL DEFAULT 'inherit', created_at TEXT NOT NULL)",
  );
  const created = new Date().toISOString();
  const insert = db.prepare(
    "INSERT OR REPLACE INTO projects (id, name, workspace_root, egress, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run(projectId, projectId, workspaceRoot, "inherit", created);
  // The legacy default project: the Sidebar's own list always holds it, and the office's route
  // resolves a workspace through it like any other (the machine serves one ROOT, and this one
  // shares it). A deployment has this row from its first migration.
  insert.run("default", "default", workspaceRoot, "inherit", created);
  const statement = (query: string, bindings: readonly (string | number | null)[]): D1Statement => {
    const read = (): unknown[] => db.prepare(query).all(...bindings);
    const self: D1Statement = {
      bind: (...values) => statement(query, values),
      all: async () => ({ results: read().map((row) => ({ ...(row as object) })) }),
      first: async () => {
        const rows = read();
        const row = rows[0];
        return row === undefined ? null : { ...(row as object) };
      },
      run: async () => ({ meta: { changes: Number(db.prepare(query).run(...bindings).changes) } }),
    };
    return self;
  };
  return {
    prepare: (query) => statement(query, []),
    batch: async (statements) => Promise.all(statements.map(async (item) => await item.run())),
    close: () => db.close(),
  };
}