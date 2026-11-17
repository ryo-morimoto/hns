import { ProjectIdSchema } from "@hns/core";
import { openStore } from "@hns/store";
import * as v from "valibot";
import { expect, test } from "vitest";
import { envWith } from "../../test/support/edge.ts";
import { openFakeD1 } from "../../test/support/d1.ts";
import { projectFor, StoreUnavailableError } from "./store.ts";

const id = (value: string) => v.parse(ProjectIdSchema, value);

// Catches: a lookup that opens the store but never reads the row, or one that invents a project.
test("a project is read from the database and a missing id is undefined", async () => {
  const database = openFakeD1();
  const seeded = await openStore({ d1: database.db, newId: () => "p1" });
  try {
    await seeded.projects.create("one", "projects/one");
  } finally {
    await seeded.close();
  }
  try {
    const project = await projectFor({ DB: database.db }, id("p1"));
    expect(project?.workspace_root).toBe("projects/one");
    expect(await projectFor({ DB: database.db }, id("missing"))).toBeUndefined();
  } finally {
    database.close();
  }
});

// Catches: a missing binding reported as a corrupt project rather than an outage.
test("a missing database is an unavailable error", async () => {
  await expect(projectFor(envWith(), id("p1"))).rejects.toThrow(StoreUnavailableError);
});
