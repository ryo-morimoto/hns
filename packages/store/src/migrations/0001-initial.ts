import type { Migration } from "./migration.ts";

const SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  request_id TEXT,
  conversation_id TEXT,
  status INTEGER,
  duration_ms INTEGER,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS usage_log (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  at TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  cost REAL NOT NULL,
  request_id TEXT
);
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  graph_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  graph_json TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS workflow_nodes (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt TEXT,
  output TEXT,
  conversation_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (run_id, node_id)
);
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  action_json TEXT NOT NULL,
  token TEXT UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_fired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS firings (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_at ON events (at);
CREATE INDEX IF NOT EXISTS usage_at ON usage_log (at);
CREATE INDEX IF NOT EXISTS conversations_project ON conversations (project_id, updated_at);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks (project_id, created_at);
CREATE INDEX IF NOT EXISTS workflows_project ON workflows (project_id, created_at);
CREATE INDEX IF NOT EXISTS workflow_runs_workflow ON workflow_runs (workflow_id, created_at);
CREATE INDEX IF NOT EXISTS automations_project ON automations (project_id, created_at);
CREATE INDEX IF NOT EXISTS firings_automation ON firings (automation_id, created_at);
`;

/**
 * The first schema step: projects, tasks, conversations, events, usage, workflows, automations.
 *
 * @remarks
 * Applied versions are append-only. Changing a statement here would make an already-migrated
 * database and a fresh one disagree; add a new version file instead.
 */
export const migration0001: Migration = { version: 1, sql: SQL };
