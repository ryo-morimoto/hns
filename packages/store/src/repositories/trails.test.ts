import { expect, test } from "vitest";
import { isoTimestamp } from "@hns/core";
import type { Sql } from "../sql.ts";
import { trailRepository } from "./trails.ts";

/**
 * The run -> Trail link a checkpoint Change writer asks for (0272n).
 *
 * @remarks
 * trailForRun is the one question the Workspace object asks before it writes a TrailChange:
 * "is this run linked to a Trail, and to which one". The SQL is the repository own, run through
 * a recording port so this unit test needs no workerd; the integration suite runs the same
 * statement against the real schema.
 */

/** One statement the repository ran. */
interface Asked {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * The SQL port, answering rows to every read and recording what was asked.
 *
 * @param rows - The rows every read answers with.
 * @returns The port and the statements it ran.
 */
function recording(rows: readonly unknown[]) {
  const asked: Asked[] = [];
  const sql: Sql = {
    all: (text, params = []) => {
      asked.push({ sql: text, params });
      return Promise.resolve(rows);
    },
    get: (text, params = []) => {
      asked.push({ sql: text, params });
      return Promise.resolve(undefined);
    },
    run: () => Promise.resolve(0),
    batch: () => Promise.resolve([]),
    close: () => Promise.resolve(),
  };
  return { sql, asked };
}

/** The repository over a recording port. */
function repository(sql: Sql) {
  return trailRepository({
    sql,
    // The clock is only read by writes, which this file does not make; it is still the
    // store's own timestamp type, because that is what a store is built with.
    now: () => isoTimestamp("2026-11-18T00:00:00.000Z"),
    newId: () => "id-1",
  });
}

// Catches: the run -> Trail question reading a column a link is not written with, or taking a
// corrupt link row as this run Trail.
test("trailForRun reads the link Trail, newest first, and skips a row that names none", async () => {
  const { sql, asked } = recording([{ trail_id: "trail-2" }, { trail_id: 7 }, { trail_id: "old" }]);
  expect(await repository(sql).trailForRun("run-1")).toBe("trail-2");
  expect(asked).toHaveLength(1);
  // Both columns name the run: a Run is a conversation, so a link written with either names it.
  expect(asked[0]?.sql).toContain("run_id = ? OR conversation_id = ?");
  expect(asked[0]?.sql).toContain("ORDER BY linked_at DESC");
  expect(asked[0]?.params).toStrictEqual(["run-1", "run-1"]);
});

// Catches: a run linked to no Trail being given one (the Change writer creates no Trail).
test("a run with no link has no Trail", async () => {
  const { sql } = recording([]);
  expect(await repository(sql).trailForRun("run-unlinked")).toBeUndefined();
});

// Catches: a database that cannot be read answering "no Trail" instead of failing, which would let
// a broken link silently drop the Change a checkpoint was supposed to write.
test("a database failure is not an absent link", async () => {
  const { sql } = recording([]);
  sql.all = () => Promise.reject(new Error("D1 is down"));
  await expect(repository(sql).trailForRun("run-1")).rejects.toThrow("D1 is down");
});
