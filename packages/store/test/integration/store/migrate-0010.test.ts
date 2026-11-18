import { expect, test } from "vitest";
import * as v from "valibot";
import {
  TRAIL_ACTOR_KINDS,
  TRAIL_CHANGE_STATES,
  TRAIL_DECISION_ACTIONS,
  TRAIL_EVAL_STATUSES,
  TRAIL_FEEDBACK_CHANNELS,
  TRAIL_FEEDBACK_SENTIMENTS,
  TRAIL_FINDING_SEVERITIES,
  TRAIL_FINDING_SOURCES,
  TRAIL_FINDING_STATUSES,
  TRAIL_GATE_KINDS,
  TRAIL_GATE_STATUSES,
  TRAIL_KINDS,
  TRAIL_PRIORITIES,
  TRAIL_STATES,
} from "@hns/core";
import { migrate } from "../../../src/migrate.ts";
import { MIGRATIONS } from "../../../src/migrations/index.ts";
import { migration0010 } from "../../../src/migrations/0010-trails.ts";
import { parseTrail, parseTrailNote } from "../../../src/parse.ts";
import { createSql, type Sql } from "../../../src/sql.ts";
import { createD1Harness, type D1Harness } from "../harness.ts";

/**
 * Migration 0010: the Trail tables and the backfill from `tasks` (D104, trail-model-v1 §6.1/§7).
 *
 * @remarks
 * The test runs against the real SQLite D1 gives the store. It shows the step applies to an empty
 * database and to one that already holds tasks, that the version moves from 9 to 10, that the old
 * board maps onto the Trail states, and that the CHECKs are the closed vocabulary. The issue calls
 * this step 0004; it is 0010 because 0004 to 0009 were applied before it (the module says so).
 */

let harness: D1Harness;

/** Open a fresh database, run `work`, and close everything afterwards. */
async function withDatabase<T>(work: (sql: Sql, db: D1Harness) => Promise<T>): Promise<T> {
  harness = await createD1Harness();
  await harness.reset();
  const sql = createSql(harness.db);
  try {
    return await work(sql, harness);
  } finally {
    await sql.close();
    await harness.dispose();
  }
}

/** One `schema_migrations` row. */
const VersionSchema = v.object({ version: v.number() });

/** A `trails` row with every column `SELECT *` returns. */
const TrailRow = v.object({
  id: v.string(),
  project_id: v.string(),
  title: v.string(),
  description: v.string(),
  acceptance: v.string(),
  kind: v.string(),
  state: v.string(),
  priority: v.string(),
  created_by: v.string(),
  created_at: v.string(),
  updated_at: v.string(),
});

/** A `trail_notes` row. */
const NoteRow = v.object({ trail_id: v.string(), body: v.string() });

const latestVersion = async (sql: Sql): Promise<number> => {
  const rows = await sql.all("SELECT version FROM schema_migrations ORDER BY version");
  return v.parse(VersionSchema, rows[rows.length - 1]).version;
};

const trailTables = [
  "trails",
  "trail_changes",
  "trail_sessions",
  "trail_feedback",
  "trail_metrics",
  "trail_evals",
  "trail_notes",
  "trail_decisions",
  "trail_findings",
  "trail_gates",
] as const;

// Catches: the Trail tables added without the version that records them, or the step placed out
// of order in the applied list.
test("0010 is the last step and applies to an empty database, moving the version from 9 to 10", async () => {
  expect(migration0010.version).toBe(10);
  expect(MIGRATIONS[MIGRATIONS.length - 1]?.version).toBe(10);
  await withDatabase(async (sql) => {
    await migrate(
      sql,
      MIGRATIONS.filter((migration) => migration.version <= 9),
    );
    expect(await latestVersion(sql)).toBe(9);
    await migrate(sql, MIGRATIONS);
    expect(await latestVersion(sql)).toBe(10);
    for (const table of trailTables) {
      const found = await sql.all(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        [table],
      );
      expect(found, table).toHaveLength(1);
    }
  });
});

// Catches: a backfill that loses a task, rewrites the old row, or maps the board onto the wrong
// Trail states (the issue's C1).
test("existing tasks are backfilled with the board mapped onto the Trail states", async () => {
  await withDatabase(async (sql) => {
    // A database an older build left behind: the schema through step 9, with tasks in it.
    await migrate(
      sql,
      MIGRATIONS.filter((migration) => migration.version <= 9),
    );
    await sql.run("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)", [
      "p1",
      "one",
      "2026-01-01T00:00:00.000Z",
    ]);
    const tasks = [
      { id: "t-todo", status: "todo", title: "a todo" },
      { id: "t-doing", status: "doing", title: "a doing" },
      { id: "t-done", status: "done", title: "a done" },
      { id: "t-blocked", status: "blocked", title: "a blocked" },
    ];
    for (const task of tasks) {
      await sql.run(
        "INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [
          task.id,
          "p1",
          task.title,
          task.status,
          "2026-01-02T00:00:00.000Z",
          "2026-01-03T00:00:00.000Z",
        ],
      );
    }
    await migrate(sql, MIGRATIONS);

    const byId = new Map(
      (await sql.all("SELECT * FROM trails ORDER BY id")).map((row) => {
        const trail = v.parse(TrailRow, row);
        return [trail.id, trail] as const;
      }),
    );
    expect(byId.size).toBe(4);
    expect(byId.get("trail-t-todo")).toMatchObject({
      project_id: "p1",
      title: "a todo",
      state: "draft",
      created_by: "backfill",
    });
    expect(byId.get("trail-t-doing")?.state).toBe("active");
    // done is "the work stopped", not "the change was merged": the backfill never claims a merge
    // the old row did not record (a Trail that really merged is moved later, by the table).
    expect(byId.get("trail-t-done")?.state).toBe("closed");
    // blocked is not a Trail state: the Trail is active and a note carries why it was stuck.
    expect(byId.get("trail-t-blocked")?.state).toBe("active");
    const notes = (await sql.all("SELECT trail_id, body FROM trail_notes ORDER BY trail_id")).map(
      (row) => v.parse(NoteRow, row),
    );
    expect(notes).toStrictEqual([{ trail_id: "trail-t-blocked", body: "blocked" }]);
    // Every stored row reads as the public model: the row schema agrees with what was written.
    for (const row of await sql.all("SELECT * FROM trails")) expect(parseTrail(row)).toBeTruthy();
    // The old rows are untouched: the tasks surface still reads them until its own issue.
    expect(await sql.all("SELECT id, status FROM tasks ORDER BY id")).toStrictEqual([
      { id: "t-blocked", status: "blocked" },
      { id: "t-doing", status: "doing" },
      { id: "t-done", status: "done" },
      { id: "t-todo", status: "todo" },
    ]);
  });
});

// Catches: a backfilled note attached to a Trail the backfill did not make, which would need the
// foreign key to be ignored to pass.
test("the backfilled note names the Trail the backfill made", async () => {
  await withDatabase(async (sql) => {
    await migrate(
      sql,
      MIGRATIONS.filter((migration) => migration.version <= 9),
    );
    await sql.run("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)", [
      "p1",
      "one",
      "2026-01-01T00:00:00.000Z",
    ]);
    await sql.run(
      "INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["b1", "p1", "stuck", "blocked", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z"],
    );
    const before = await sql.all("SELECT COUNT(*) AS count FROM tasks");
    await migrate(sql, MIGRATIONS);
    expect(await sql.all("SELECT COUNT(*) AS count FROM tasks")).toStrictEqual(before);
    const note = await sql.get("SELECT * FROM trail_notes WHERE trail_id = ?", ["trail-b1"]);
    expect(parseTrailNote(note).occurred_at).toBe("2026-01-02T00:00:00.000Z");
  });
});

// Catches: an applied CHECK whose vocabulary is not the one core declares — a value the type
// admits that the table refuses, or the other way round.
test("the Trail CHECKs are the core vocabularies", async () => {
  await withDatabase(async (sql) => {
    await migrate(sql, MIGRATIONS);
    const ddl = v.parse(
      v.object({ sql: v.string() }),
      await sql.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'trails'"),
    ).sql;
    for (const state of TRAIL_STATES) expect(ddl).toContain("'" + state + "'");
    for (const kind of TRAIL_KINDS) expect(ddl).toContain("'" + kind + "'");
    for (const priority of TRAIL_PRIORITIES) expect(ddl).toContain("'" + priority + "'");
    const expectations: readonly (readonly [string, readonly string[]])[] = [
      ["trail_changes", TRAIL_CHANGE_STATES],
      [
        "trail_feedback",
        [...TRAIL_FEEDBACK_CHANNELS, ...TRAIL_FEEDBACK_SENTIMENTS, ...TRAIL_ACTOR_KINDS],
      ],
      ["trail_evals", TRAIL_EVAL_STATUSES],
      ["trail_decisions", TRAIL_DECISION_ACTIONS],
      [
        "trail_findings",
        [...TRAIL_FINDING_SEVERITIES, ...TRAIL_FINDING_SOURCES, ...TRAIL_FINDING_STATUSES],
      ],
      ["trail_gates", [...TRAIL_GATE_KINDS, ...TRAIL_GATE_STATUSES]],
    ];
    for (const [table, values] of expectations) {
      const tableDdl = v.parse(
        v.object({ sql: v.string() }),
        await sql.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table]),
      ).sql;
      for (const value of values)
        expect(tableDdl, table + " " + value).toContain("'" + value + "'");
    }
  });
});

// Catches: a hand-edited Trail row inventing a state, which the surface would then have to guess
// about; the table refuses it at the write.
test("the trails table refuses a state outside the vocabulary", async () => {
  await withDatabase(async (sql) => {
    await migrate(sql, MIGRATIONS);
    await sql.run("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)", [
      "p1",
      "one",
      "2026-01-01T00:00:00.000Z",
    ]);
    await expect(
      sql.run(
        "INSERT INTO trails (id, project_id, title, description, acceptance, kind, state, priority, " +
          "created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "bad",
          "p1",
          "t",
          "",
          "",
          "feature",
          "blocked",
          "normal",
          "u",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
        ],
      ),
    ).rejects.toThrow();
  });
});

// Catches: a project delete leaving its Trails behind (the cascade T-6 relies on).
test("deleting a project deletes its Trails", async () => {
  await withDatabase(async (sql) => {
    await migrate(sql, MIGRATIONS);
    await sql.batch([{ sql: "PRAGMA foreign_keys = ON" }]);
    await sql.run("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)", [
      "p1",
      "one",
      "2026-01-01T00:00:00.000Z",
    ]);
    await sql.run(
      "INSERT INTO trails (id, project_id, title, description, acceptance, kind, state, priority, " +
        "created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "t1",
        "p1",
        "t",
        "",
        "",
        "feature",
        "draft",
        "normal",
        "u",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ],
    );
    await sql.run("DELETE FROM projects WHERE id = ?", ["p1"]);
    expect(await sql.all("SELECT id FROM trails")).toStrictEqual([]);
  });
});
