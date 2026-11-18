import type { Migration } from "./migration.ts";

// The closed vocabulary is written here as well as in core's constants, because a migration may
// not import core: it is the applied SQL that must refuse a hand-edited row, and the core
// constants can grow while an already-applied CHECK cannot. A test pins the two together.
const SQL = `
CREATE TABLE IF NOT EXISTS trails (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('feature','fix','chore','spike')),
  state TEXT NOT NULL CHECK (state IN ('draft','active','in_review','merged','observing','closed','abandoned')),
  priority TEXT NOT NULL CHECK (priority IN ('urgent','high','normal','low')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trail_changes (
  id TEXT PRIMARY KEY,
  trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  repo_id TEXT,
  base_commit TEXT NOT NULL,
  head_commit TEXT NOT NULL CHECK (head_commit <> base_commit),
  run_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('open','in_review','merged','abandoned')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trail_sessions (
  id TEXT PRIMARY KEY,
  trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  conversation_id TEXT,
  session_id TEXT NOT NULL,
  run_id TEXT,
  linked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trail_feedback (
  id TEXT PRIMARY KEY,
  trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  change_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('in_app','email','support','interview','other')),
  summary TEXT NOT NULL,
  sentiment TEXT NOT NULL CHECK (sentiment IN ('positive','neutral','negative')),
  source_url TEXT,
  source TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('user','agent','service')),
  external_id TEXT,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  supersedes_id TEXT
);
CREATE TABLE IF NOT EXISTS trail_metrics (
  id TEXT PRIMARY KEY,
  trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  change_id TEXT,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  source TEXT NOT NULL,
  external_id TEXT,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trail_evals (
  id TEXT PRIMARY KEY,
  trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  change_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass','fail','error')),
  detail TEXT,
  source TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trail_notes (
  id TEXT PRIMARY KEY,
  trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trail_decisions (
  id TEXT PRIMARY KEY,
  trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  change_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approve','request_changes','reject')),
  head_commit TEXT,
  note TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trail_findings (
  id TEXT PRIMARY KEY,
  trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  change_id TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('high','medium','low','none')),
  source TEXT NOT NULL CHECK (source IN ('agent','test','human')),
  status TEXT NOT NULL CHECK (status IN ('open','resolved','dismissed')),
  file TEXT,
  hunk TEXT,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE TABLE IF NOT EXISTS trail_gates (
  id TEXT PRIMARY KEY,
  trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  change_id TEXT,
  gate TEXT NOT NULL CHECK (gate IN ('human_review','tests','findings','freshness')),
  status TEXT NOT NULL CHECK (status IN ('pending','pass','fail','ask')),
  detail TEXT,
  evaluated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trails_project ON trails (project_id, state, updated_at);
CREATE INDEX IF NOT EXISTS trail_changes_trail ON trail_changes (trail_id, created_at);
CREATE INDEX IF NOT EXISTS trail_sessions_trail ON trail_sessions (trail_id, linked_at);
CREATE INDEX IF NOT EXISTS trail_feedback_trail ON trail_feedback (trail_id, recorded_at);
CREATE INDEX IF NOT EXISTS trail_metrics_trail ON trail_metrics (trail_id, name, window_end);
CREATE INDEX IF NOT EXISTS trail_evals_trail ON trail_evals (trail_id, recorded_at);
CREATE INDEX IF NOT EXISTS trail_notes_trail ON trail_notes (trail_id, recorded_at);
CREATE INDEX IF NOT EXISTS trail_decisions_trail ON trail_decisions (trail_id, at);
CREATE INDEX IF NOT EXISTS trail_findings_trail ON trail_findings (trail_id, created_at);
CREATE INDEX IF NOT EXISTS trail_gates_trail ON trail_gates (trail_id, evaluated_at);
INSERT OR IGNORE INTO trails (id, project_id, title, description, acceptance, kind, state, priority, created_by, created_at, updated_at)
  SELECT 'trail-' || tasks.id, tasks.project_id, tasks.title, '', '', 'chore',
    CASE tasks.status
      WHEN 'todo' THEN 'draft'
      WHEN 'doing' THEN 'active'
      WHEN 'done' THEN 'closed'
      ELSE 'active'
    END,
    'normal', 'backfill', tasks.created_at, tasks.updated_at
  FROM tasks;
INSERT INTO trail_notes (id, trail_id, body, author, occurred_at, recorded_at)
  SELECT 'trail-backfill-' || tasks.id, 'trail-' || tasks.id, 'blocked', 'store', tasks.updated_at, tasks.updated_at FROM tasks WHERE tasks.status = 'blocked';
`;

/**
 * The tenth schema step: the Trail tables, and the Tasks that already exist backfilled into them
 * (D104, trail-model-v1 §6.1 and §7).
 *
 * @remarks
 * Additive only: ten new tables and their indexes. No existing table changes, and `tasks` stays
 * readable — the surface stops reading it in the issue that follows, and dropping it is a
 * decision of its own.
 *
 * **The number is 0010, not the 0004 the issue was opened with.** The issue was written when the
 * Trail decision (D104) was to be the fourth step; by the time it was implemented the store had
 * already applied 0004 (`projects.workspace_root` and `egress`) through 0009
 * (`conversations.edited_at`). A migration's number is its position in the applied list, so
 * reusing 0004 would mean either rewriting an applied step or leaving a gap, and the runner
 * refuses both. The D104 text and the issue's title still say 0004; this file is that step.
 *
 * **The backfill maps the old board onto the new states** (trail-model-v1 §7): `todo` to
 * `draft` (intent, no change yet), `doing` to `active`.
 *
 * **`done` maps to `closed`, not to `merged`**, although §7 writes `done → merged`. A task's
 * `done` means the work stopped; a Trail's `merged` means its change reached the base branch, and
 * claiming that for a task that never had a Change would be a fact the old row never said. `closed`
 * (tracking ended) is the state that does not claim a merge. A Trail whose intent did produce a
 * change gets one through `trails.addChange` and moves by the table, so a person who knows the
 * commit is not blocked by this mapping.
 *
 * **`blocked` is not a Trail state** (D104), so a blocked task becomes `active` and a
 * `trail_notes` row says why it was stuck — the note carries the word `blocked`, which is the
 * only record the old row leaves.
 *
 * **Ids keep the task's id** (`trail-<task>`, and the note's `trail-backfill-<task>`), so a row can
 * be traced back to the task it came from — and forward, when the Tasks are removed: a Trail's id
 * is the only link the backfill leaves to the old row. `created_by` is `backfill`: no session
 * subject created these rows. The Trail's kind is `chore` and its priority `normal`, because a
 * task had neither; the description and acceptance are empty for the same reason, and a person
 * fills them in. A status outside the four is `closed` too: it is not a state this build knows,
 * so the row must not claim to be moving.
 *
 * The Trail is inserted before the note that explains a blocked task: both run in the migration's
 * one batch (one transaction), and the note's `trail_id` names a Trail, so the Trail has to be
 * there first for a database that enforces the foreign key.
 *
 * The closed vocabularies are CHECKed, so a hand-edited row cannot invent a state, a severity, or
 * a gate. A CHECK sees only the row it writes, so `trail_changes` is the one table whose rule is
 * about its own columns (a Change has a difference: `head_commit <> base_commit`); the store and
 * the migration pin the same set of states, and a test compares them.
 */
export const migration0010: Migration = { version: 10, sql: SQL };
