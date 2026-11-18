import * as v from "valibot";
import {
  TRAIL_STATES,
  canTrailTransition,
  trailStateWithFirstChange,
  type ProjectId,
  type Trail,
  type TrailChange,
  type TrailDecision,
  type TrailDecisionAction,
  type TrailFinding,
  type TrailGate,
  type TrailPriority,
  type TrailSession,
  type TrailState,
} from "@hns/core";
import type { StoreContext } from "../db.ts";
import { parseTrail, parseTrailChange, parseTrailDecision, parseTrailFinding } from "../parse.ts";
import {
  TrailChangeRowSchema,
  TrailDecisionRowSchema,
  TrailFindingRowSchema,
  TrailGateRowSchema,
  TrailRowSchema,
  TrailSessionRowSchema,
} from "../schemas.ts";

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
 * - `invalid_head`: an approval named no head, or a head this Trail's Changes do not name. An
 *   approval that names nothing could never be told apart from a later head (C2), so it is not
 *   recorded.
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
  | { readonly kind: "corrupt_row"; readonly refused: true }
  | { readonly kind: "invalid_head"; readonly refused: true };

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
 * What a caller supplies to record a Decision.
 *
 * @remarks
 * A Decision is append-only: this is the whole of it, and nothing edits one afterwards. `note` is
 * the point a person typed, and is stored even when empty. `resolveFindingIds` is the revise path:
 * the findings the review said were addressed become `resolved` in the same D1 batch, so a
 * requested change and the points it answers are written together or not at all.
 */
export interface TrailDecisionCreateInput {
  readonly action: TrailDecisionAction;
  /** The session subject or agent that decided. */
  readonly actor: string;
  readonly note: string;
  /** The Change the decision is about. */
  readonly changeId?: string | undefined;
  /** The commit the decision was made against; an approval must name it (D104). */
  readonly headCommit?: string | undefined;
  /** Findings a revise answers; they become `resolved` when the decision is stored. */
  readonly resolveFindingIds?: readonly string[] | undefined;
}

/**
 * What a caller supplies to raise a Finding.
 *
 * @remarks
 * A Finding is recorded, never derived: an agent, a test, or a person raises it. `none` is "a note
 * without weight", so it can be stored and shown without blocking anything.
 */
export interface TrailFindingCreateInput {
  readonly changeId?: string | undefined;
  readonly severity: TrailFinding["severity"];
  readonly source: TrailFinding["source"];
  readonly summary: string;
  readonly file?: string | undefined;
  readonly hunk?: string | undefined;
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
 * A Change a method returned as stored.
 *
 * @remarks
 * The same discriminated shape as {@link TrailRowValue}: `refused: false` marks a row, and its
 * absence is what makes {@link TrailWriteRefusal} the other half of the union.
 */
export type TrailChangeValue = TrailChange & { readonly refused: false };

/**
 * A Trail's session link a method returned as stored.
 *
 * @remarks
 * The same discriminated shape as {@link TrailRowValue}.
 */
export type TrailSessionValue = TrailSession & { readonly refused: false };

/** A Finding a method returned as stored. */
export type TrailFindingValue = TrailFinding & { readonly refused: false };

/** A Decision a method returned as stored. */
export type TrailDecisionValue = TrailDecision & { readonly refused: false };

/** A gate evaluation a method returned as stored. */
export type TrailGateValue = TrailGate & { readonly refused: false };

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
 * - `listChanges` reads a `trail_changes` row through {@link TrailChangeRowSchema} with
 *   `v.safeParse` the same way, and answers `corrupt_row` when it fails. A Change that does not
 *   parse is refused, not thrown: a surface shows the Change list it read, and an unreadable row
 *   in it means the list cannot be served.
 *
 * **No read of this repository throws for a stored row.** `parseTrail` / `parseTrailChange` are
 * used for the rows this repository is about to **write**, so a malformed value is refused before
 * it reaches SQLite; see `create` and `addChange`.
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
 * **The GraphQL face is the first caller** (0231): `Query.trails` / `trail(id)` and the Trail's
 * `changes` list read through this repository, and `createTrail` / `updateTrail` write through
 * it, so the state machine is checked in the layer that persists it.
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
  /**
   * The Changes of a Trail, oldest first.
   *
   * @returns The Changes, or a one-entry array holding the `corrupt_row` refusal when a stored
   * Change does not parse: the same shape `list` answers with, and for the same reason — a list
   * that silently dropped a row it could not read would hide the corruption it is meant to
   * surface. An empty list is an empty array.
   */
  listChanges(trailId: string): Promise<readonly (TrailChangeValue | TrailWriteRefusal)[]>;
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
  /**
   * The sessions a Trail is linked to, oldest link first.
   *
   * @returns The links, or a one-entry array holding the `corrupt_row` refusal when a stored link
   * does not parse — the same shape every list of this repository answers with. An empty array is
   * a Trail with no session.
   */
  listSessions(trailId: string): Promise<readonly (TrailSessionValue | TrailWriteRefusal)[]>;
  /**
   * The findings raised on a Trail, newest first.
   *
   * @returns The findings, or a one-entry array holding the `corrupt_row` refusal. Newest first is
   * the order a reader wants: the point just raised is the one being discussed.
   */
  listFindings(trailId: string): Promise<readonly (TrailFindingValue | TrailWriteRefusal)[]>;
  /**
   * The decisions recorded on a Trail, newest first.
   *
   * @returns The decisions, or a one-entry array holding the `corrupt_row` refusal.
   *
   * @remarks
   * Newest first is what an approval rule needs (`core`'s `trailCurrentApproval` reads the list
   * in this order) and what a reviewer reads: the last thing decided is the first line.
   */
  listDecisions(trailId: string): Promise<readonly (TrailDecisionValue | TrailWriteRefusal)[]>;
  /**
   * The gate evaluations recorded on a Trail, newest first.
   *
   * @returns The gate rows, or a one-entry array holding the `corrupt_row` refusal.
   *
   * @remarks
   * These are the **evidence** a gate left at a moment. The state a screen shows now is computed
   * from the Trail's head, findings, and decisions (`core`'s `trailGates`), because a stored
   * answer would go stale the moment the head moved.
   */
  listGates(trailId: string): Promise<readonly (TrailGateValue | TrailWriteRefusal)[]>;
  /**
   * Record a Decision, and the findings it answers, as one batch.
   *
   * @returns The stored Decision; `not_found` when the Trail (or the Change it names) is missing.
   * @throws ValiError when the row this repository would write fails its schema.
   *
   * @remarks
   * **An approval names a head commit, and the Trail has to have it.** An `approve` without
   * `headCommit`, or naming a head the Trail's Changes do not name, is `invalid_request`: the
   * whole point of the head on an approval is that a later head can be told apart from it
   * (C2), and an approval that names nothing could never go stale.
   *
   * A `request_changes` with `resolveFindingIds` resolves those findings in the same D1 batch, so
   * a revise and the points it answers are stored together or not at all. A finding that is not
   * this Trail's is `not_found`, and nothing is written.
   */
  addDecision(
    trailId: string,
    input: TrailDecisionCreateInput,
  ): Promise<TrailDecisionValue | TrailWriteRefusal>;
  /**
   * Raise a Finding on a Trail.
   *
   * @returns The stored Finding, which starts `open`. `not_found` when the Trail (or the Change
   * it names) is missing.
   * @throws ValiError when the row this repository would write fails its schema.
   */
  addFinding(
    trailId: string,
    input: TrailFindingCreateInput,
  ): Promise<TrailFindingValue | TrailWriteRefusal>;
  /**
   * The base commit a Trail's review is compared against: the oldest Change's `base_commit`.
   *
   * @returns The base commit, or undefined when the Trail has no Change.
   *
   * @remarks
   * C4 (the next Run starts from the previous Run's head) and the freshness gate need "the base
   * the review is against": the first commit the Trail was taken from. Reading it from the
   * Changes rather than asking a machine keeps the store the only source a gate reads.
   */
  baseCommit(trailId: string): Promise<string | undefined>;
  /**
   * The latest Change of a Trail: the head its review is about.
   *
   * @returns The newest Change, or undefined when the Trail has none.
   *
   * @remarks
   * "Newest" is by `created_at`, the order `listChanges` reads. A review, an approval, and the
   * gates all address this Change's head (C2); a Trail with several Changes is approved for the
   * last one.
   */
  headChange(trailId: string): Promise<TrailChangeValue | undefined>;
  /**
   * The Trail a run is linked to, if any.
   *
   * @param runId - The run (a conversation) whose Trail is asked for.
   * @returns The Trail's id, or undefined when no Trail is linked to that run.
   *
   * @remarks
   * The link is `trail_sessions.run_id` — the row that says "this Trail's work happened in this
   * run" (a Run is a conversation, so `conversation_id` names the same id and a link may carry
   * either). This is the **only** question the checkpoint's Change writer asks before it writes
   * (0272n): a run with no such link gets no Change, because a Change on a Trail nobody linked it
   * to would be a Trail this platform invented for the run.
   *
   * A Trail whose newest link is not this run is not this run's Trail: the newest link wins, so a
   * Trail that moved on to a later run does not keep receiving the earlier run's checkpoints. A
   * row this build cannot parse is skipped rather than failing the read: one corrupt link is not a
   * reason for a checkpoint's Change to fail.
   */
  trailForRun(runId: string): Promise<string | undefined>;
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

  /**
   * Whether a Change the caller named belongs to this Trail.
   *
   * @returns The Change's row, or undefined when the id is not this Trail's.
   */
  const changeOf = async (
    trailId: string,
    changeId: string,
  ): Promise<TrailChangeValue | undefined> => {
    const row = await sql.get("SELECT * FROM trail_changes WHERE id = ? AND trail_id = ? LIMIT 1", [
      changeId,
      trailId,
    ]);
    if (row === undefined) return undefined;
    const parsed = readReturned(TrailChangeRowSchema, row, "trail change was not read");
    return parsed.refused ? undefined : parsed;
  };

  /**
   * Read one list of a Trail's rows, validating every row before it is typed.
   *
   * @returns The rows, or a one-entry array holding the `corrupt_row` refusal — the shape every
   * list of this repository answers with, so a caller has one rule for all five.
   */
  const listOf = async <TValue>(
    schema: v.GenericSchema<unknown, TValue>,
    statement: string,
    trailId: string,
  ): Promise<readonly (TValue & { readonly refused: false })[] | readonly TrailWriteRefusal[]> => {
    const rows = await sql.all(statement, [trailId]);
    const values: (TValue & { readonly refused: false })[] = [];
    for (const row of rows) {
      const parsed = v.safeParse(schema, row);
      if (!parsed.success) return [{ kind: "corrupt_row", refused: true }];
      values.push(stored(parsed.output));
    }
    return values;
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
      // The rows are validated before they are typed, like `list`: an unknown value anywhere
      // refuses the list instead of flowing on as a Change this build would misread.
      const changes: TrailChangeValue[] = [];
      for (const row of rows) {
        const parsed = v.safeParse(TrailChangeRowSchema, row);
        if (!parsed.success) return [{ kind: "corrupt_row", refused: true }];
        changes.push(stored(parsed.output));
      }
      return changes;
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
    listSessions(trailId) {
      return listOf(
        TrailSessionRowSchema,
        "SELECT * FROM trail_sessions WHERE trail_id = ? ORDER BY linked_at",
        trailId,
      );
    },
    listFindings(trailId) {
      return listOf(
        TrailFindingRowSchema,
        "SELECT * FROM trail_findings WHERE trail_id = ? ORDER BY created_at DESC, id DESC",
        trailId,
      );
    },
    listDecisions(trailId) {
      return listOf(
        TrailDecisionRowSchema,
        "SELECT * FROM trail_decisions WHERE trail_id = ? ORDER BY at DESC, id DESC",
        trailId,
      );
    },
    listGates(trailId) {
      return listOf(
        TrailGateRowSchema,
        "SELECT * FROM trail_gates WHERE trail_id = ? ORDER BY evaluated_at DESC, id DESC",
        trailId,
      );
    },
    async headChange(trailId) {
      // The same order the Change list is read in, so "the latest Change" is the last one it shows.
      const row = await sql.get(
        "SELECT * FROM trail_changes WHERE trail_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
        [trailId],
      );
      if (row === undefined) return undefined;
      const parsed = readReturned(TrailChangeRowSchema, row, "trail change was not read");
      return parsed.refused ? undefined : parsed;
    },
    async trailForRun(runId) {
      // Both columns are the same run: a Run is a conversation, so a link that was written with
      // only one of them set still names this run. Newest first, because a Trail that was linked
      // to several runs belongs to the one it was linked to last.
      const rows = await sql.all(
        "SELECT trail_id FROM trail_sessions WHERE run_id = ? OR conversation_id = ? ORDER BY linked_at DESC, id DESC",
        [runId, runId],
      );
      for (const row of rows) {
        const parsed = v.safeParse(v.object({ trail_id: v.string() }), row);
        // A link whose row does not name a Trail is corruption, not this run's Trail: the next
        // link is asked instead of failing the whole answer.
        if (parsed.success) return parsed.output.trail_id;
      }
      return undefined;
    },
    async baseCommit(trailId) {
      const row = await sql.get(
        "SELECT base_commit FROM trail_changes WHERE trail_id = ? ORDER BY created_at, id LIMIT 1",
        [trailId],
      );
      if (row === undefined) return undefined;
      return v.parse(v.object({ base_commit: v.string() }), row).base_commit;
    },
    async addFinding(trailId, input) {
      const trail = await readState(trailId);
      if (trail.kind !== "state") return { ...trail, refused: true };
      if (input.changeId !== undefined && !(await changeOf(trailId, input.changeId)))
        return { kind: "not_found", refused: true };
      const stamp = now();
      const finding = parseTrailFinding({
        id: newId(),
        trail_id: trailId,
        change_id: input.changeId ?? null,
        severity: input.severity,
        source: input.source,
        status: "open",
        file: input.file ?? null,
        hunk: input.hunk ?? null,
        summary: input.summary,
        created_at: stamp,
        resolved_at: null,
        resolved_by: null,
      });
      const row = await sql.get(
        "INSERT INTO trail_findings (id, trail_id, change_id, severity, source, status, file, hunk, " +
          "summary, created_at, resolved_at, resolved_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "RETURNING *",
        [
          finding.id,
          finding.trail_id,
          finding.change_id,
          finding.severity,
          finding.source,
          finding.status,
          finding.file,
          finding.hunk,
          finding.summary,
          finding.created_at,
          finding.resolved_at,
          finding.resolved_by,
        ],
      );
      return readReturned(TrailFindingRowSchema, row, "trail finding was not created");
    },
    async addDecision(trailId, input) {
      const trail = await readState(trailId);
      if (trail.kind !== "state") return { ...trail, refused: true };
      // An approval names the head it decides: one the Trail's Changes do not name could never be
      // told apart from the head it is about later (C2), so it is refused before anything is written.
      if (input.action === "approve") {
        const heads = await sql.all("SELECT head_commit FROM trail_changes WHERE trail_id = ?", [
          trailId,
        ]);
        const known = heads.some(
          (row) =>
            v.parse(v.object({ head_commit: v.string() }), row).head_commit === input.headCommit,
        );
        if (input.headCommit === undefined || !known)
          return { kind: "invalid_head", refused: true };
      }
      if (input.changeId !== undefined && !(await changeOf(trailId, input.changeId)))
        return { kind: "not_found", refused: true };
      const resolveIds = input.resolveFindingIds ?? [];
      for (const findingId of resolveIds) {
        const row = await sql.get("SELECT id FROM trail_findings WHERE id = ? AND trail_id = ?", [
          findingId,
          trailId,
        ]);
        if (row === undefined) return { kind: "not_found", refused: true };
      }
      const stamp = now();
      const decision = parseTrailDecision({
        id: newId(),
        trail_id: trailId,
        change_id: input.changeId ?? null,
        actor: input.actor,
        action: input.action,
        head_commit: input.headCommit ?? null,
        note: input.note,
        at: stamp,
      });
      // The decision and the findings a revise answers are one batch: a revise that resolved
      // nothing because it was half written would say two things about the same review.
      const results = await sql.batch([
        {
          sql:
            "INSERT INTO trail_decisions (id, trail_id, change_id, actor, action, head_commit, note, at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
          params: [
            decision.id,
            decision.trail_id,
            decision.change_id,
            decision.actor,
            decision.action,
            decision.head_commit,
            decision.note,
            decision.at,
          ],
        },
        ...resolveIds.map((findingId) => ({
          sql:
            "UPDATE trail_findings SET status = 'resolved', resolved_at = ?, resolved_by = ? " +
            "WHERE id = ? AND trail_id = ?",
          params: [stamp, input.actor, findingId, trailId],
        })),
      ]);
      const row = results[0]?.[0];
      if (row === undefined) throw new Error("trail decision was not created");
      return readReturned(TrailDecisionRowSchema, row, "trail decision was not read");
    },
    isState(value): value is TrailState {
      // SAFETY: TRAIL_STATES is the union's own list, so a member of it is a TrailState; the
      // comparison is against every legal value and nothing else.
      return TRAIL_STATES.includes(value as TrailState);
    },
  };
}
