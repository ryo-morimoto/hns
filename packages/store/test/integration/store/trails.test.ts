import { expect, test } from "vitest";
import * as v from "valibot";
import { TRAIL_STATES, canTrailTransition } from "@hns/core";
import type { ProjectId, TrailState } from "@hns/core";
import { afterAll, beforeAll } from "vitest";
import { openStore, type Store } from "../../../src/index.ts";
import type { TrailRowValue, TrailWriteRefusal } from "../../../src/index.ts";
import { migrate } from "../../../src/migrate.ts";
import { MIGRATIONS } from "../../../src/migrations/index.ts";
import { createSql } from "../../../src/sql.ts";
import { clock, counter } from "../../support.ts";
import { createD1Harness, type D1Harness } from "../harness.ts";

/**
 * The Trail repository against the real D1 SQLite.
 *
 * @remarks
 * The production parts are paired with each other: the repository writes its own SQL into the
 * tables migration 0010 creates, and every value it hands back went through `parseTrail`. No
 * fake stands in for either side. The test covers the round trip a surface needs (create, get,
 * list, update), the closed state move, the first change's move, and the two failures the issue
 * names: a corrupted row, and `merged -> abandoned`.
 */

let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

/** Open a fresh store for one test, closing it afterwards. */
async function withStore(run: (store: Store) => Promise<void>): Promise<void> {
  await harness.reset();
  const store = await openStore({ d1: harness.db, now: clock(), newId: counter() });
  try {
    await run(store);
  } finally {
    await store.close();
  }
}

/**
 * A project id the test can pass to the repository.
 *
 * @remarks
 * The brand exists only in the type; `default` is the project `openStore` seeds, so the cast is
 * naming a row the test just read rather than inventing one.
 */
// SAFETY: `openStore` seeds the project with exactly this id.
const DEFAULT_PROJECT: ProjectId = "default" as ProjectId;

/**
 * Create a Trail and return its id.
 *
 * @remarks
 * `create` answers with the row or, in principle, a refusal; the schema refuses every malformed
 * Trail before it is written, so a refusal here is a defect and the test fails loudly on it.
 * @returns The new Trail's id.
 * @throws Error when the value is a refusal rather than a Trail.
 */
async function createTrailId(
  store: Store,
  input: { readonly title: string; readonly projectId?: ProjectId },
): Promise<string> {
  return idOf(
    await store.trails.create({
      projectId: input.projectId ?? DEFAULT_PROJECT,
      title: input.title,
      createdBy: "u",
    }),
  );
}

/**
 * Narrow a store answer to the stored row.
 *
 * @remarks
 * The methods answer with the row or a refusal. In these tests the row is what was just written,
 * so a refusal is a defect of the store and this throws instead of being asserted around.
 * @param value - The value a method returned, or `undefined` for a miss.
 * @returns The stored row.
 * @throws Error when the value is a refusal or a miss.
 */
function expectStored(value: TrailRowValue | TrailWriteRefusal | undefined): TrailRowValue {
  if (value === undefined || value.refused)
    throw new Error("expected a Trail, got " + (value === undefined ? "nothing" : value.kind));
  return value;
}

/** The id of a created Trail: {@link expectStored}, then its id. */
function idOf(value: TrailRowValue | TrailWriteRefusal): string {
  return expectStored(value).id;
}

// Catches: a create that stores one value and returns another, a get that cannot find what create
// wrote, a list that is not newest first, or an update that loses the fields it did not patch.
test("a Trail round-trips through create, get, list, and update", async () => {
  await withStore(async (store) => {
    const first = await store.trails.create({
      projectId: DEFAULT_PROJECT,
      title: "first",
      createdBy: "user-1",
    });
    // A created Trail is a stored row, not a refusal: the discriminant says so for TypeScript too.
    expect(first).toMatchObject({
      project_id: "default",
      title: "first",
      description: "",
      acceptance: "",
      kind: "feature",
      state: "draft",
      priority: "normal",
      created_by: "user-1",
      refused: false,
    });
    const created = idOf(first);
    expect(await store.trails.get(created)).toStrictEqual(first);

    const second = await store.trails.create({
      projectId: DEFAULT_PROJECT,
      title: "second",
      description: "why",
      acceptance: "checks pass",
      kind: "fix",
      priority: "high",
      createdBy: "user-2",
    });
    const stored = [first, second];
    expect(await store.trails.list()).toStrictEqual(stored.toReversed());
    expect((await store.trails.list(DEFAULT_PROJECT)).map((trail) => "id" in trail)).toStrictEqual([
      true,
      true,
    ]);

    const updated = expectStored(
      await store.trails.update(created, { title: "renamed", priority: "urgent" }),
    );
    // The patch is applied over the row that was stored, and nothing else in it changes.
    const wroteAt = updated.updated_at;
    expect(updated).toStrictEqual({
      ...first,
      title: "renamed",
      priority: "urgent",
      updated_at: wroteAt,
    });
    expect(updated).toMatchObject({
      title: "renamed",
      priority: "urgent",
      description: "",
      kind: "feature",
      refused: false,
    });
    // The store moves the write time: an update is activity the list's cursor can follow.
    expect(await store.trails.get(created)).toStrictEqual(updated);
    expect(await store.trails.update("missing", { title: "x" })).toBeUndefined();
  });
});

// Catches: a list that returns rows from every project when one was named, which is the read a
// sidebar makes.
test("a Trail list can be scoped to its project", async () => {
  await withStore(async (store) => {
    const other = await store.projects.create("other", "projects/other");
    const keep = await store.trails.create({
      projectId: DEFAULT_PROJECT,
      title: "keep",
      createdBy: "u",
    });
    await store.trails.create({ projectId: other.id, title: "drop", createdBy: "u" });
    expect(await store.trails.list(other.id)).toStrictEqual([
      expect.objectContaining({ title: "drop" }),
    ]);
    expect(await store.trails.list(DEFAULT_PROJECT)).toStrictEqual([keep]);
  });
});

// Catches: a corrupted row read as a default state instead of failing at the boundary.
//
// The column's CHECK refuses an unknown state on the way in, so this test reaches the read with a
// row the CHECK never saw: a database migrated through the Trail step by a build whose table has
// no CHECK. The table is dropped and recreated without one, and a state no vocabulary contains is
// written. The read refuses the row rather than reading it as a draft or a default; a well-formed
// row in the same table still reads. The unit test in parse.test.ts covers every vocabulary.
test("a stored state outside the vocabulary fails the read", async () => {
  await withStore(async (store) => {
    await harness.exec(
      "DROP TABLE trails; " +
        "CREATE TABLE trails (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, " +
        "description TEXT NOT NULL, acceptance TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, " +
        "priority TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
    );
    await harness.exec(
      "INSERT INTO trails (id, project_id, title, description, acceptance, kind, state, priority, created_by, created_at, updated_at) " +
        "VALUES ('corrupt', 'default', 'corrupt', '', '', 'feature', 'blocked', 'normal', 'u', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'); " +
        "INSERT INTO trails (id, project_id, title, description, acceptance, kind, state, priority, created_by, created_at, updated_at) " +
        "VALUES ('good', 'default', 'good', '', '', 'feature', 'draft', 'normal', 'u', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');",
    );
    expect(await store.trails.get("corrupt")).toStrictEqual({ kind: "corrupt_row", refused: true });
    // One unreadable row refuses the list rather than hiding itself.
    expect(await store.trails.list()).toStrictEqual([{ kind: "corrupt_row", refused: true }]);
    expect(await store.trails.transition("corrupt", "abandoned")).toStrictEqual({
      kind: "corrupt_row",
      refused: true,
    });
    // The refusal is about that row, not the table: a well-formed row beside it still reads.
    expect(await store.trails.get("good")).toMatchObject({ title: "good", refused: false });
  });
});

// Catches: the one read of the Trail repository that used to throw, after 0231 made every read
// answer a value. A Change state is checked on the way in, so the row a legacy build wrote is
// made here (a table without the CHECK); the read refuses it instead of throwing a ValiError.
test("a stored Change state outside the vocabulary refuses the Change list", async () => {
  await withStore(async (store) => {
    const trail = await createTrailId(store, { title: "corrupt change" });
    const good = await store.trails.addChange(trail, {
      workspaceId: "ws-1",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
    });
    expect(good.refused).toBe(false);
    await harness.exec(
      "DROP TABLE trail_changes; " +
        "CREATE TABLE trail_changes (id TEXT PRIMARY KEY, trail_id TEXT NOT NULL, " +
        "workspace_id TEXT NOT NULL, repo_id TEXT, base_commit TEXT NOT NULL, " +
        "head_commit TEXT NOT NULL, run_id TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL, " +
        "updated_at TEXT NOT NULL);",
    );
    await harness.exec(
      "INSERT INTO trail_changes (id, trail_id, workspace_id, repo_id, base_commit, head_commit, run_id, state, created_at, updated_at) " +
        "VALUES ('corrupt', '" +
        trail +
        "', 'ws-1', NULL, 'aaa', 'bbb', NULL, 'reopened', " +
        "'2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');",
    );
    // One unreadable Change refuses the list rather than hiding itself, and nothing throws.
    expect(await store.trails.listChanges(trail)).toStrictEqual([
      { kind: "corrupt_row", refused: true },
    ]);
  });
});
// Catches: a state move stored without consulting the table — the issue's C4 refusal.
test("merged cannot be abandoned, and the refusal names both states", async () => {
  await withStore(async (store) => {
    const trail = await createTrailId(store, { title: "merged" });
    // Walk the legal path to merged: draft -> active -> in_review -> merged.
    for (const to of ["active", "in_review", "merged"] as const) {
      const moved = await store.trails.transition(trail, to);
      expect(moved.refused).toBe(false);
      if (!moved.refused) expect(moved.state).toBe(to);
    }
    const refused = await store.trails.transition(trail, "abandoned");
    expect(refused).toStrictEqual({
      kind: "invalid_transition",
      from: "merged",
      to: "abandoned",
      refused: true,
    });
    expect(await store.trails.get(trail)).toMatchObject({ state: "merged", refused: false });
    expect(await store.trails.transition("missing", "active")).toStrictEqual({
      kind: "not_found",
      refused: true,
    });
  });
});

// Catches: a move that the table forbids from a state the caller did not read, and a move that
// stores itself as a change (draft -> draft must not be an "update").
test("every move in the table is allowed and every other move is refused", async () => {
  await withStore(async (store) => {
    for (const from of TRAIL_STATES) {
      for (const to of TRAIL_STATES) {
        const trail = await createTrailId(store, { title: from + "->" + to });
        // Put the Trail in `from` through a legal path, then ask for `to`.
        for (const step of pathTo(from)) await store.trails.transition(trail, step);
        const result = await store.trails.transition(trail, to);
        if (canTrailTransition(from, to)) {
          expect(result.refused, from + " -> " + to).toBe(false);
          if (!result.refused) expect(result.state).toBe(to);
        } else {
          expect(result, from + " -> " + to).toStrictEqual({
            kind: "invalid_transition",
            from,
            to,
            refused: true,
          });
          expect(await store.trails.get(trail)).toMatchObject({ state: from, refused: false });
        }
      }
    }
  });
});

/**
 * The legal moves that reach `state` from a new Trail.
 *
 * @param state - The state a test wants a Trail in.
 * @returns The moves to apply, in order.
 */
function pathTo(state: TrailState): readonly TrailState[] {
  switch (state) {
    case "draft":
      return [];
    case "active":
      return ["active"];
    case "in_review":
      return ["active", "in_review"];
    case "merged":
      return ["active", "in_review", "merged"];
    case "observing":
      return ["active", "in_review", "merged", "observing"];
    case "closed":
      return ["active", "in_review", "merged", "observing", "closed"];
    case "abandoned":
      return ["abandoned"];
    default: {
      const unreachable: never = state;
      throw new Error("unexpected state: " + String(unreachable));
    }
  }
}

// Catches: the first Change leaving the Trail in draft, so the Trail that has work still reads as
// an intent — the issue's C3.
test("the first Change moves a draft Trail to active and is stored beside it", async () => {
  await withStore(async (store) => {
    const trail = await createTrailId(store, { title: "first change" });
    const change = await store.trails.addChange(trail, {
      workspaceId: "ws-1",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
    });
    expect(change.refused).toBe(false);
    if (!change.refused) {
      expect(change).toMatchObject({
        trail_id: trail,
        workspace_id: "ws-1",
        repo_id: null,
        run_id: null,
        state: "open",
        base_commit: "a".repeat(40),
        head_commit: "b".repeat(40),
      });
      // The list is read fresh: the Change above was the value the insert returned.
      expect(await store.trails.listChanges(trail)).toStrictEqual([{ ...change, refused: false }]);
    }
    expect(await store.trails.get(trail)).toMatchObject({ state: "active", refused: false });
    // A second change does not move an active Trail, and is listed after the first.
    const second = await store.trails.addChange(trail, {
      workspaceId: "ws-1",
      baseCommit: "b".repeat(40),
      headCommit: "c".repeat(40),
    });
    expect(second.refused).toBe(false);
    expect(await store.trails.listChanges(trail)).toHaveLength(2);
    expect(await store.trails.get(trail)).toMatchObject({ state: "active", refused: false });
  });
});

// Catches: a Change with no difference stored, or a change added to a Trail that does not exist.
test("a change whose head equals its base, or a missing Trail, is refused and writes nothing", async () => {
  await withStore(async (store) => {
    const trail = await createTrailId(store, { title: "no change" });
    const same = await store.trails.addChange(trail, {
      workspaceId: "ws-1",
      baseCommit: "a".repeat(40),
      headCommit: "a".repeat(40),
    });
    expect(same).toStrictEqual({
      kind: "invalid_change",
      base_commit: "a".repeat(40),
      head_commit: "a".repeat(40),
      refused: true,
    });
    expect(await store.trails.listChanges(trail)).toStrictEqual([]);
    expect(
      await store.trails.addChange("missing", {
        workspaceId: "ws-1",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
      }),
    ).toStrictEqual({ kind: "not_found", refused: true });
    // The Trail did not move: a refused change is not a change.
    expect(await store.trails.get(trail)).toMatchObject({ state: "draft", refused: false });
  });
});

// Catches: a Trail whose creation is refused by the row schema leaving a half-written row.
test("a malformed Trail is refused before it is written", async () => {
  await withStore(async (store) => {
    // A JS caller can pass a title the type refuses; the store's own schema must refuse it too.
    // An empty title is the same failure in a form the type admits, so the type is not the check.
    await expect(
      store.trails.create({ projectId: DEFAULT_PROJECT, title: "", createdBy: "u" }),
    ).rejects.toThrow();
    expect(await store.trails.list()).toStrictEqual([]);
  });
});

// Catches: a deleted project leaving its Trails, which the cascade promises not to.
test("deleting a project deletes its Trails", async () => {
  await withStore(async (store) => {
    const project = await store.projects.create("gone", "projects/gone");
    await store.trails.create({ projectId: project.id, title: "t", createdBy: "u" });
    await store.projects.delete(project.id);
    expect(await store.trails.list(project.id)).toStrictEqual([]);
  });
});

// Catches: the repository shipping rows whose version this build cannot be sure it migrated.
test("the store opens at the migration that created the Trail tables", async () => {
  await harness.reset();
  const sql = createSql(harness.db);
  try {
    await migrate(sql, MIGRATIONS);
    const row = await sql.get("SELECT MAX(version) AS version FROM schema_migrations");
    expect(v.parse(v.object({ version: v.number() }), row).version).toBe(10);
  } finally {
    await sql.close();
  }
});

/**
 * The review reads and writes of the Trail repository (0232) against the real D1.
 *
 * @remarks
 * The repository writes and reads the four tables the review face shows (sessions, findings,
 * decisions, gates) and the two questions the gates ask (the head Change and the base commit).
 * No fake stands in for either side: the SQL is the production SQL, the rows are migration
 * 0010's, and every list goes through the row's schema.
 */

// Catches: a decided approval that does not name a head, or one for a commit the Trail does not
// have — the stale-approval hole C2 closes.
test("a decision is stored with its head, and an approval of an unknown head is refused", async () => {
  await withStore(async (store) => {
    const trail = await createTrailId(store, { title: "reviewed" });
    const change = await store.trails.addChange(trail, {
      workspaceId: "ws-1",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
    });
    if (change.refused) throw new Error("the change was refused");
    const unknown = await store.trails.addDecision(trail, {
      action: "approve",
      actor: "u",
      note: "",
      headCommit: "c".repeat(40),
    });
    expect(unknown).toStrictEqual({ kind: "invalid_head", refused: true });
    expect(await store.trails.listDecisions(trail)).toStrictEqual([]);

    const approved = await store.trails.addDecision(trail, {
      action: "approve",
      actor: "u",
      note: "looks right",
      headCommit: "b".repeat(40),
    });
    expect(approved.refused).toBe(false);
    if (approved.refused) throw new Error("the decision was refused");
    expect(approved).toMatchObject({
      action: "approve",
      head_commit: "b".repeat(40),
      change_id: null,
      note: "looks right",
      refused: false,
    });
    // Newest first, so a later decision is the first one read.
    await store.trails.addDecision(trail, {
      action: "request_changes",
      actor: "u",
      note: "",
      headCommit: "b".repeat(40),
    });
    const decisions = await store.trails.listDecisions(trail);
    expect(decisions.map((value) => (value.refused ? "refused" : value.action))).toStrictEqual([
      "request_changes",
      "approve",
    ]);
  });
});

// Catches: a revise that records the decision and drops the points it said it addressed, and a
// finding from another Trail resolved by this one's decision.
test("a revise resolves the findings it names, in the same batch", async () => {
  await withStore(async (store) => {
    const trail = await createTrailId(store, { title: "revised" });
    const other = await createTrailId(store, { title: "somebody else" });
    const raised = await store.trails.addFinding(trail, {
      severity: "high",
      source: "agent",
      summary: "loops",
      file: "src/app.ts",
      hunk: "@@ -1,1 +1,2 @@",
    });
    if (raised.refused) throw new Error("the finding was refused");
    expect(raised).toMatchObject({ status: "open", resolved_at: null, resolved_by: null });
    const elsewhere = await store.trails.addFinding(other, {
      severity: "low",
      source: "human",
      summary: "not this trail",
    });
    if (elsewhere.refused) throw new Error("the finding was refused");

    const foreign = await store.trails.addDecision(trail, {
      action: "request_changes",
      actor: "u",
      note: "",
      resolveFindingIds: [elsewhere.id],
    });
    expect(foreign).toStrictEqual({ kind: "not_found", refused: true });

    const revised = await store.trails.addDecision(trail, {
      action: "request_changes",
      actor: "reviewer",
      note: "",
      resolveFindingIds: [raised.id],
    });
    expect(revised.refused).toBe(false);
    const findings = await store.trails.listFindings(trail);
    expect(findings.map((value) => (value.refused ? "refused" : value.status))).toStrictEqual([
      "resolved",
    ]);
    const first = findings[0];
    if (first === undefined || first.refused) throw new Error("no finding");
    expect(first.resolved_by).toBe("reviewer");
    expect(first.resolved_at).not.toBe(null);
    // The other Trail's finding is untouched by this Trail's decision.
    const untouched = await store.trails.listFindings(other);
    expect(untouched.map((value) => (value.refused ? "refused" : value.status))).toStrictEqual([
      "open",
    ]);
  });
});

// Catches: the head and base the gate compares not being the Change's own (a gate about a change
// nobody made), and a Trail with no Change answering something other than "none".
test("the repository answers the head Change and the base commit", async () => {
  await withStore(async (store) => {
    const trail = await createTrailId(store, { title: "heads" });
    expect(await store.trails.headChange(trail)).toBeUndefined();
    expect(await store.trails.baseCommit(trail)).toBeUndefined();
    const first = await store.trails.addChange(trail, {
      workspaceId: "ws-1",
      baseCommit: "1".repeat(40),
      headCommit: "2".repeat(40),
    });
    const second = await store.trails.addChange(trail, {
      workspaceId: "ws-1",
      baseCommit: "2".repeat(40),
      headCommit: "3".repeat(40),
    });
    if (first.refused || second.refused) throw new Error("a change was refused");
    const head = await store.trails.headChange(trail);
    expect(head?.head_commit).toBe("3".repeat(40));
    expect(await store.trails.baseCommit(trail)).toBe("1".repeat(40));
  });
});

// Catches: a row of a review table this build cannot parse being dropped from a list instead of
// refusing it (which would hide the corruption) or thrown (which would fail the request as 500).
test("a review row this build cannot parse refuses its list, it does not throw", async () => {
  await withStore(async (store) => {
    const trail = await createTrailId(store, { title: "corrupt finding" });
    await harness.exec(
      "DROP TABLE trail_findings; " +
        "CREATE TABLE trail_findings (id TEXT PRIMARY KEY, trail_id TEXT NOT NULL, change_id TEXT, " +
        "severity TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, file TEXT, hunk TEXT, " +
        "summary TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT);",
    );
    await harness.exec(
      "INSERT INTO trail_findings (id, trail_id, change_id, severity, source, status, file, hunk, " +
        "summary, created_at, resolved_at, resolved_by) VALUES ('f1', '" +
        trail +
        "', NULL, 'critical', 'agent', 'open', NULL, NULL, 'x', " +
        "'2026-01-01T00:00:00.000Z', NULL, NULL);",
    );
    expect(await store.trails.listFindings(trail)).toStrictEqual([
      { kind: "corrupt_row", refused: true },
    ]);
    // The other lists of the same Trail still read.
    expect(await store.trails.listDecisions(trail)).toStrictEqual([]);
  });
});

// Catches: a session link stored with a conversation id that is not a conversation id, which a
// screen would then follow to a conversation that cannot exist.
test("session links are stored and read back with their conversation id", async () => {
  await withStore(async (store) => {
    const trail = await createTrailId(store, { title: "linked" });
    await harness.exec(
      "INSERT INTO trail_sessions (id, trail_id, conversation_id, session_id, run_id, linked_at) " +
        "VALUES ('s1', '" +
        trail +
        "', " +
        "NULL, 'session-1', NULL, '2026-01-01T00:00:00.000Z'), " +
        "('s2', '" +
        trail +
        "', NULL, 'session-2', 'run-1', '2026-01-02T00:00:00.000Z');",
    );
    const sessions = await store.trails.listSessions(trail);
    expect(sessions.map((value) => (value.refused ? "refused" : value.session_id))).toStrictEqual([
      "session-1",
      "session-2",
    ]);
  });
});
