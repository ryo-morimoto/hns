import { expect, test } from "vitest";
import { openSqliteState } from "../../test/support/sqlite.ts";
import { countStoredRows } from "./meter.ts";

test("an object with no tables stores no rows", () => {
  const opened = openSqliteState();
  try {
    expect(countStoredRows(opened.state.storage)).toBe(0);
  } finally {
    opened.close();
  }
});

// Catches: a row count that misses a table, so a turn's delta is always zero.
test("every table contributes to the row count", () => {
  const opened = openSqliteState();
  try {
    const sql = opened.state.storage.sql;
    sql.exec("CREATE TABLE first (value TEXT)");
    sql.exec("CREATE TABLE second (value TEXT)");
    sql.exec("INSERT INTO first (value) VALUES ('a'), ('b')");
    sql.exec("INSERT INTO second (value) VALUES ('c')");
    expect(countStoredRows(opened.state.storage)).toBe(3);
    sql.exec("INSERT INTO second (value) VALUES ('d')");
    expect(countStoredRows(opened.state.storage)).toBe(4);
  } finally {
    opened.close();
  }
});
