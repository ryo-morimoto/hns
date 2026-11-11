import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import * as v from "valibot";
import { openStore, type D1Binding, type Store } from "../../src/index.ts";
import { clock, counter } from "../support.ts";

/** A D1 database backed by miniflare's workerd SQLite, with per-test isolation. */
export interface D1Harness {
  readonly db: D1Binding;
  /** Drop every table and view, then open a migrated store with the deterministic clock and ids. */
  withStore(run: (store: Store) => Promise<void>): Promise<void>;
  /** Drop every table and view so the next open starts from an empty database. */
  reset(): Promise<void>;
  /** Run a setup script that the store itself does not need (views, raw DDL). */
  exec(sql: string): Promise<void>;
  /** Stop workerd. */
  dispose(): Promise<void>;
}

const objectSchema = v.object({ name: v.string(), type: v.picklist(["table", "view"]) });

/**
 * Start miniflare and return a harness over its D1 database.
 *
 * @remarks
 * The store tests need a child process (workerd), so they live in the integration layer.
 * Each test drops every table before opening, because D1 has no in-memory database per
 * connection.
 */
export async function createD1Harness(): Promise<D1Harness> {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      script: "export default { fetch() { return new Response('ok'); } }",
      modules: true,
      d1Databases: ["DB"],
    }),
  );
  // SAFETY: miniflare types its D1 database as any; this is the test edge.
  const raw: D1Binding & { exec(sql: string): Promise<void> } = await mf.getD1Database("DB");
  const db: D1Binding = raw;

  const reset = async (): Promise<void> => {
    const result = await raw
      .prepare(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    const entries = (result.results ?? []).map((row) => v.parse(objectSchema, row));
    if (entries.length === 0) return;
    await raw.exec(
      entries
        .map((entry) => {
          const name = '"' + entry.name.replaceAll('"', '""') + '"';
          return (entry.type === "view" ? "DROP VIEW IF EXISTS " : "DROP TABLE IF EXISTS ") + name;
        })
        .join("; "),
    );
  };

  return {
    db,
    reset,
    async withStore(run) {
      await reset();
      const store = await openStore({ d1: db, now: clock(), newId: counter() });
      try {
        await run(store);
      } finally {
        await store.close();
      }
    },
    exec: async (sql) => {
      await raw.exec(sql);
    },
    dispose: () => mf.dispose(),
  };
}
