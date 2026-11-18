import * as v from "valibot";
import {
  TRAIL_STATES,
  canTrailTransition,
  trailStateWithFirstChange,
  type ProjectId,
  type Trail,
  type TrailChange,
  type TrailPriority,
  type TrailState,
} from "@hns/core";
import type { StoreContext } from "../db.ts";
import { parseTrail, parseTrailChange } from "../parse.ts";
import { TrailRowSchema } from "../schemas.ts";

/**
 * A write the Trail repository refuses.
 *
 * @remarks
 * These are expected outcomes, not defects: a store method returns one instead of throwing, so a
 * surface maps it to its own failure union without catching an exception. A refusal writes
 * nothing.
 *
 * - `not_found`: no Trail has that id, or the id is no longer the state the caller read.
 * - `invalid_transition`: the move is not in the Trail transition table (for example
 *   `merged -> abandoned`), or the row's state is not one this build knows.
 * - `invalid_change`: a Change whose `head_commit` equals its `base_commit`, which is no change.
 * - `corrupt_row`: the row the caller asked about does not parse — a stored value this build does
 *   not know, in a column the table's CHECK could not refuse. The read fails closed and says so;
 *   it is not a defect of the caller's request, and it is not a default either.
 *
 * Every refusal carries `refused: true` and every stored row carries `refused: false`, so a caller
 * branches on one boolean and the two outcomes are a discriminated union for a TypeScript reader.
 * Which keys are present would not do: an entity's id is a string and a refusal's `kind` is also a
 * string, so "has a `kind`" does not narrow.
 */
export type TrailWriteRefusal =
  | { readonly kind: "not_found"; readonly refused: true }
  | {
      readonly kind: "invalid_transition";
      readonly from: string;
      readonly to: string;
      readonly refused: true;
    }
  | {
      readonly kind: "invalid_change";
      readonly base_commit: string;
      readonly head_commit: string;
      readonly refused: true;
    }
  | { readonly kind: "corrupt_row"; readonly refused: true };

/**
 * What a caller supplies to create a Trail.
 *
 * @remarks
 * `description`, `acceptance`, `kind`, and `priority` have defaults: an intent may start as a
 * title. The state is never supplied — a Trail starts `draft` and moves by the table.
 */
export interface TrailCreateInput {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly description?: string | undefined;
  readonly acceptance?: string | undefined;
  readonly kind?: Trail["kind"] | undefined;
  readonly priority?: TrailPriority | undefined;
  /** The session subject or agent creating it. */
  readonly createdBy: string;
}

/**
 * What a caller supplies to add a Change.
 *
 * @remarks
 * `repoId` and `runId` are absent while a Trail has one repository or no run.
 */
export interface TrailChangeCreateInput {
  readonly workspaceId: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly repoId?: string | undefined;
  readonly runId?: string | undefined;
}

/**
 * A Trail's fields that a caller may change.
 *
 * @remarks
 * Every field is optional; a present one replaces the stored value. `state` is here so one method
 * moves a Trail, and it is checked against the transition table before it is written. The state
 * is not part of the patch type: a caller says what it wants the state to be, and the repository
 * decides whether the move is legal from the state the row holds.
 */
export interface TrailUpdate {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly acceptance?: string | undefined;
  readonly kind?: Trail["kind"] | undefined;
  readonly priority?: TrailPriority | undefined;
}

/**
 * A Trail a method returned as stored.
 *
 * @remarks
 * `refused: false` is what makes {@link TrailWriteRefusal} the other half of a union: a caller
 * writes `if (result.refused)` and TypeScript narrows both ways without a cast. It is not part of
 * the model (`@hns/core`'s `Trail`) and never leaves the process.
 */
export type TrailRowValue = Trail & { readonly refused: false };

/**
 * Trails: the unit of work (D104), the rows a Task used to be.

 * @remarks
 * **Every answer is parsed into the model, and a Trail that does not parse is a value.** The
 * reader is split two ways, and the split is deliberate:
 *
 * - `get`, `list`, `create`, `update`, and `transition` read a `trails` row through
 *   {@link TrailRowSchema} with `v.safeParse`, and answer `corrupt_row` when it fails, because
 *   their callers can act on "this row is unreadable". They do not call `parseTrail`, which
 *   throws for the same input: the schema is the one check, and these methods turn its failure
 *   into a value.
 * - `listChanges` calls `parseTrailChange`, which throws a `ValiError`. It is the **only**
 *   throwing read of this repository today; a caller that needs a refusal value for a Change
 *   gets one when it arrives, not before (no surface reads a Change list yet).
 *
 * `create` also parses the row it is about to write with `parseTrail` first, so a malformed
 * Trail is refused before it reaches SQLite. `addChange` parses the Change it is about to write
 * with `parseTrailChange` the same way.
 *
 * **No method throws for an expected refusal**: a missing row, an illegal move, or a change
 * without a difference is a {@link TrailWriteRefusal} value.
 *
 * **A state move is one conditional `UPDATE`**: `WHERE id = ? AND state = <the state read>`, so a
 * concurrent move loses rather than overwriting a state nobody read, and the caller gets
 * `not_found` for a Trail that moved underneath it. Each write is one statement, because D1 has
 * no interactive transaction.
 *
 * **Nothing calls this yet.** No GraphQL resolver or Web screen reads a Trail: that surface is
 * the next issue. The repository exists so that issue has one place to write a Trail's state
 * through, and so the transition table is checked in the layer that persists it.
 */
export interface TrailRepository {
  /**
   * Trails across every project, or only `projectId`; newest first.
   *
   * @returns The Trails, newest first, or a one-entry array holding the `corrupt_row` refusal: a
   * list that silently dropped a row it could not read would hide the corruption it is meant to
   * surface. An empty list is an empty array.
   */
  list(projectId?: ProjectId | undefined): Promise<readonly (TrailRowValue | TrailWriteRefusal)[]>;
  /**
   * The Trail with `id`.
   *
   * @returns The Trail, or `not_found`, or `corrupt_row` when the stored row does not parse — a
   * surface shows the second as a broken Trail rather than as a missing one.
   */
  get(id: string): Promise<TrailRowValue | TrailWriteRefusal>;
  /**
   * Create a Trail in `projectId`.
   *
   * @returns The stored Trail, which starts `draft`.
   * @throws ValiError when the row this repository would write fails its schema, such as a title
   * that is not a string.
   */
  create(input: TrailCreateInput): Promise<TrailRowValue | TrailWriteRefusal>;
  /**
   * Update the given fields, keeping the rest.
   *
   * @returns The updated Trail, or `undefined` when no row has this id.
   * @throws ValiError when the row this repository would write fails its schema.
   */
  update(id: string, patch: TrailUpdate): Promise<TrailRowValue | TrailWriteRefusal | undefined>;
  /**
   * Move a Trail to `to`, refused unless the table allows it.
   *
   * @param id - The Trail to move.
   * @param to - The state to store.
   * @returns The moved Trail, or a {@link TrailWriteRefusal}.
   *
   * @remarks
   * The refusal reads the row it holds, not a state the caller passed: `merged -> abandoned` is
   * refused with `from: "merged"` even when a caller believed the Trail was somewhere else. A
   * row whose state is not in the vocabulary is `invalid_transition`, not a default.
   */
  transition(id: string, to: TrailState): Promise<TrailRowValue | TrailWriteRefusal>;
  /** The Changes of a Trail, oldest first. */
  listChanges(trailId: string): Promise<Array<TrailChange & { readonly refused: false }>>;
  /**
   * Add a Change to a Trail.
   *
   * @returns The stored Change; a Trail still in `draft` moves to `active` in the same batch.
   * @throws ValiError when the Change row this repository would write fails its schema.
   *
   * @remarks
   * The Change and the Trail's first move are one D1 batch, so a Trail never has a Change while
   * still claiming to be an intent with none. A Change whose head equals its base is
   * `invalid_change` and nothing is written.
   */
  addChange(
    trailId: string,
    input: TrailChangeCreateInput,
  ): Promise<(TrailChange & { readonly refused: false }) | TrailWriteRefusal>;
  /** Whether `value` is a Trail state this build knows (useful to a surface before a write). */
  isState(value: string): value is TrailState;
}

/**
 * Stamp a parsed row with the discriminator that says it is a row and not a refusal.
 *
 * @internal
 */
const stored = <T>(value: T): T & { readonly refused: false } => ({ ...value, refused: false });

/**
 * Build the Trail repository over `context`.
 *
 * @internal
 */
export function trailRepository(context: StoreContext): TrailRepository {
  const { sql, now, newId } = context;

  /**
   * Read the row a move starts from.
   *
   * @returns The current state, `not_found` when no row has the id, or `corrupt_row` when the row
   * does not parse (a stored value this build does not know).
   */
  const readState = async (
    id: string,
  ): Promise<
    | { readonly kind: "state"; readonly state: TrailState }
    | { readonly kind: "not_found" }
    | { readonly kind: "corrupt_row" }
  > => {
    const row = await sql.get("SELECT * FROM trails WHERE id = ?", [id]);
    if (row === undefined) return { kind: "not_found" };
    const parsed = v.safeParse(TrailRowSchema, row);
    if (!parsed.success) return { kind: "corrupt_row" };
    return { kind: "state", state: parsed.output.state };
  };

  /**
   * Validate whatever a statement returned into the public model.
   *
   * @returns The parsed value, or `corrupt_row` when this build cannot read what it wrote or read.
   * @throws Error for a missing `RETURNING` row, which is a defect in the statement, not a row.
   */
  /* oxlint-disable anti-slop/no-unknown-parameters --
     The value a statement returned is unparsed until this helper runs the schema; that is the
     check it exists for, and no caller sees the value before it.
  */
  const readReturned = <TValue>(
    schema: v.GenericSchema<unknown, TValue>,
    value: unknown,
    message: string,
  ): (TValue & { readonly refused: false }) | TrailWriteRefusal => {
    if (value === undefined) throw new Error(message);
    const parsed = v.safeParse(schema, value);
    return parsed.success ? stored(parsed.output) : { kind: "corrupt_row", refused: true };
  };

  const get = async (id: string): Promise<TrailRowValue | TrailWriteRefusal> => {
    const row = await sql.get("SELECT * FROM trails WHERE id = ?", [id]);
    return row === undefined
      ? { kind: "not_found", refused: true }
      : readReturned(TrailRowSchema, row, "trail was not read");
  };

  return {
    async list(projectId) {
      const rows =
        projectId === undefined
          ? await sql.all("SELECT * FROM trails ORDER BY updated_at DESC")
          : await sql.all("SELECT * FROM trails WHERE project_id = ? ORDER BY updated_at DESC", [
              projectId,
            ]);
      // The rows are validated before they are typed: an unknown state anywhere in the list
      // refuses the list instead of flowing on as a Trail this build would misread.
      const trails: Trail[] = [];
      for (const row of rows) {
        const parsed = v.safeParse(TrailRowSchema, row);
        if (!parsed.success) return [{ kind: "corrupt_row", refused: true }];
        trails.push(parsed.output);
      }
      return trails.map((trail) => stored(trail));
    },
    get,
    async create(input) {
      const stamp = now();
      const trail = parseTrail({
        id: newId(),
        project_id: input.projectId,
        title: input.title,
        description: input.description ?? "",
        acceptance: input.acceptance ?? "",
        kind: input.kind ?? "feature",
        state: "draft",
        priority: input.priority ?? "normal",
        created_by: input.createdBy,
        created_at: stamp,
        updated_at: stamp,
      });
      const row = await sql.get(
        "INSERT INTO trails (id, project_id, title, description, acceptance, kind, state, priority, " +
          "created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
        [
          trail.id,
          trail.project_id,
          trail.title,
          trail.description,
          trail.acceptance,
          trail.kind,
          trail.state,
          trail.priority,
          trail.created_by,
          trail.created_at,
          trail.updated_at,
        ],
      );
      return readReturned(TrailRowSchema, row, "trail was not created");
    },
    async update(id, patch) {
      const row = await sql.get(
        "UPDATE trails SET title = COALESCE(?, title), description = COALESCE(?, description), " +
          "acceptance = COALESCE(?, acceptance), kind = COALESCE(?, kind), " +
          "priority = COALESCE(?, priority), updated_at = ? WHERE id = ? RETURNING *",
        [
          patch.title ?? null,
          patch.description ?? null,
          patch.acceptance ?? null,
          patch.kind ?? null,
          patch.priority ?? null,
          now(),
          id,
        ],
      );
      return row === undefined
        ? undefined
        : readReturned(TrailRowSchema, row, "trail was not read");
    },
    async transition(id, to) {
      const current = await readState(id);
      if (current.kind !== "state") return { ...current, refused: true };
      if (!canTrailTransition(current.state, to))
        return { kind: "invalid_transition", from: current.state, to, refused: true };
      const row = await sql.get(
        "UPDATE trails SET state = ?, updated_at = ? WHERE id = ? AND state = ? RETURNING *",
        [to, now(), id, current.state],
      );
      // A row that moved between the read and the write is not ours to overwrite: the caller
      // lost the race and must read again.
      return row === undefined
        ? { kind: "not_found", refused: true }
        : readReturned(TrailRowSchema, row, "trail was not read");
    },
    async listChanges(trailId) {
      const rows = await sql.all(
        "SELECT * FROM trail_changes WHERE trail_id = ? ORDER BY created_at",
        [trailId],
      );
      return rows.map((row) => stored(parseTrailChange(row)));
      // A stored Change that does not parse throws here: nothing reads a Change list yet, and a
      // caller that arrives adds the refusal beside the Trail's.
    },
    async addChange(trailId, input) {
      if (input.baseCommit === input.headCommit)
        return {
          kind: "invalid_change",
          base_commit: input.baseCommit,
          head_commit: input.headCommit,
          refused: true,
        };
      const current = await readState(trailId);
      if (current.kind !== "state") return { ...current, refused: true };
      // The Trail's own state decides where a first change takes it; the table is not consulted
      // because the Trail either has no change (draft) or is already moving.
      const next = trailStateWithFirstChange(current.state);
      const stamp = now();
      const change = parseTrailChange({
        id: newId(),
        trail_id: trailId,
        workspace_id: input.workspaceId,
        repo_id: input.repoId ?? null,
        base_commit: input.baseCommit,
        head_commit: input.headCommit,
        run_id: input.runId ?? null,
        state: "open",
        created_at: stamp,
        updated_at: stamp,
      });
      const results = await sql.batch([
        {
          sql:
            "INSERT INTO trail_changes (id, trail_id, workspace_id, repo_id, base_commit, head_commit, " +
            "run_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
          params: [
            change.id,
            change.trail_id,
            change.workspace_id,
            change.repo_id,
            change.base_commit,
            change.head_commit,
            change.run_id,
            change.state,
            change.created_at,
            change.updated_at,
          ],
        },
        {
          sql: "UPDATE trails SET state = ?, updated_at = ? WHERE id = ? AND state = ?",
          params: [next, stamp, trailId, current.state],
        },
      ]);
      const row = results[0]?.[0];
      if (row === undefined) throw new Error("trail change was not created");
      return stored(parseTrailChange(row));
    },
    isState(value): value is TrailState {
      // SAFETY: TRAIL_STATES is the union's own list, so a member of it is a TrailState; the
      // comparison is against every legal value and nothing else.
      return TRAIL_STATES.includes(value as TrailState);
    },
  };
}
