import * as v from "valibot";
import type { IsoTimestamp } from "@hns/core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createD1Harness, type D1Harness } from "../harness.ts";
import { clock, counter } from "../../support.ts";
import { migrateStore, openStore } from "../../../src/index.ts";

let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

const version = async (): Promise<number> => {
  const row = await harness.db
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .first();
  return v.parse(v.object({ version: v.number() }), row).version;
};

test("opening a store migrates and seeds the default project", async () => {
  await harness.withStore(async (store) => {
    const projects = await store.projects.list();
    expect(projects.length).toBe(1);
    expect(projects[0]?.id).toBe("default");
    expect(projects[0]?.name).toBe("default");
  });
  expect(await version()).toBe(6);
});

test("reopening keeps the data and does not duplicate the default project", async () => {
  await harness.reset();
  const first = await openStore({ d1: harness.db, now: clock(), newId: counter() });
  await first.projects.create("kept", "projects/kept");
  await first.close();
  const second = await openStore({ d1: harness.db, now: clock(), newId: counter() });
  try {
    expect((await second.projects.list()).map((project) => project.name)).toStrictEqual([
      "default",
      "kept",
    ]);
  } finally {
    await second.close();
  }
  expect(await version()).toBe(6);
});

test("migrateStore applies the schema without opening the repositories", async () => {
  await harness.reset();
  await migrateStore(harness.db);
  expect(await version()).toBe(6);
  await migrateStore(harness.db);
  expect(await version()).toBe(6);
});

test("a failing migration leaves no table or version row behind", async () => {
  await harness.reset();
  // Catches: a failed migration leaving partial tables or a version row behind.
  // A view named conversations makes the migration's CREATE INDEX fail after the tables exist.
  await harness.exec("CREATE VIEW conversations AS SELECT 1 AS x");
  await expect(migrateStore(harness.db)).rejects.toThrow();
  const versionRow = await harness.db
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .first();
  expect(v.parse(v.object({ version: v.number() }), versionRow).version).toBe(0);
  const projects = await harness.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
    .first();
  expect(projects).toBe(null);
});

test("a corrupt row fails loudly when read", async () => {
  await harness.withStore(async (store) => {
    const project = await store.projects.ensureDefault();
    const task = await store.tasks.create({ projectId: project.id, title: "bad" });
    await harness.db
      .prepare("UPDATE tasks SET status = ? WHERE id = ?")
      .bind("unknown", task.id)
      .run();
    await expect(store.tasks.get(task.id)).rejects.toThrow();
  });
});

test("a non-ISO clock is refused before any write", async () => {
  await harness.reset();
  // SAFETY: a JS caller can bypass the type; the store must refuse a non-ISO clock.
  const hostileNow = () => "2026-01-01" as IsoTimestamp;
  await expect(openStore({ d1: harness.db, now: hostileNow })).rejects.toThrow();
  const row = await harness.db
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'")
    .first();
  expect(v.parse(v.object({ count: v.number() }), row).count).toBe(0);
});

test("a database newer than the store is refused", async () => {
  await harness.reset();
  await harness.exec(
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); " +
      "INSERT INTO schema_migrations (version) VALUES (99);",
  );
  await expect(openStore({ d1: harness.db, now: clock(), newId: counter() })).rejects.toThrow(
    /newer/,
  );
});

test("calls after close are refused", async () => {
  await harness.reset();
  const store = await openStore({ d1: harness.db, now: clock(), newId: counter() });
  await store.close();
  await expect(store.projects.list()).rejects.toThrow("store is closed");
});
