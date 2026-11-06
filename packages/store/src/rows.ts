/** Rows exactly as SQLite returns them. They never leave this package. */

export interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
}

export interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationRow {
  id: string;
  project_id: string;
  title: string;
  created_at: string;
  updated_at: string | null;
  archived: number;
  deleted_at: string | null;
}

export interface EventRow {
  id: string;
  at: string;
  level: string;
  event: string;
  request_id: string | null;
  conversation_id: string | null;
  status: number | null;
  duration_ms: number | null;
  detail: string | null;
}
