import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import type { IsoTimestamp } from "@hns/core";
import { expect, test } from "vitest";
import { clock, counter, withStore } from "../test/support.ts";
import { openDatabase, readUserVersion } from "./db.ts";
import { migrate } from "./migrate.ts";
import { openStore } from "./store.ts";

test("opening a store migrates and seeds the default project", () => {
  withStore((store) => {
    const projects = store.projects.list();
    expect(projects.length).toBe(1);
    expect(projects[0]?.id).toBe("default");
    expect(projects[0]?.name).toBe("default");
  });
});

test("reopening a file keeps the data and does not duplicate the default project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hns-store-"));
  const path = join(dir, "store.sqlite");
  try {
    const first = openStore({ path, now: clock(), newId: counter() });
    first.projects.create("kept");
    first.close();
    const second = openStore({ path, now: clock(), newId: counter() });
    try {
      expect(second.projects.list().map((project) => project.name)).toStrictEqual([
        "default",
        "kept",
      ]);
    } finally {
      second.close();
    }
    const db = openDatabase(path);
    try {
      expect(readUserVersion(db)).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt row fails loudly when read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hns-store-"));
  const path = join(dir, "store.sqlite");
  try {
    const seeded = openStore({ path, now: clock(), newId: counter() });
    seeded.close();
    const db = openDatabase(path);
    migrate(db);
    db.prepare(
      "INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "bad",
      "default",
      "bad",
      "unknown",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    db.close();
    const store = openStore({ path, now: clock(), newId: counter() });
    try {
      expect(() => store.tasks.get("bad")).toThrow();
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a non-ISO clock is refused before any write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hns-store-"));
  const path = join(dir, "store.sqlite");
  try {
    // SAFETY: a JS caller can bypass the type; the store must refuse a non-ISO clock.
    const hostileNow = () => "2026-01-01" as IsoTimestamp;
    expect(() => openStore({ path, now: hostileNow })).toThrow();
    const db = openDatabase(path);
    try {
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'")
        .get();
      expect(v.parse(v.object({ count: v.number() }), row).count).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a database newer than the store is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hns-store-"));
  const path = join(dir, "store.sqlite");
  try {
    const db = openDatabase(path);
    db.exec("PRAGMA user_version = 99");
    db.close();
    expect(() => openStore({ path })).toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
