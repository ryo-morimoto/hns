import { DatabaseSync } from "node:sqlite";

// The D1-like projection (0149). It holds confirmed records and a mirror of the
// live fields that D1 is allowed to see (D049: running state stays in the DO).
export function createProjection(model) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    create table conversations (id text primary key, project_id text, title text,
      created_at text, updated_at text, archived integer, deleted_at text);
    create table tasks (id text primary key, project_id text, title text, status text,
      created_at text, updated_at text);
    create table runs (id text primary key, task_id text, conversation_id text,
      workspace_id text, status text, started_at text);
    create table live_mirror (conversation_id text primary key, status text,
      needs_reason text, last_activity_at text, mirrored_at integer);
  `);
  const insConv = db.prepare("insert into conversations values (?,?,?,?,?,?,?)");
  for (const c of model.conversations) {
    insConv.run(c.id, c.project_id, c.title, c.created_at, c.updated_at, c.archived ? 1 : 0, c.deleted_at);
  }
  const insTask = db.prepare("insert into tasks values (?,?,?,?,?,?)");
  for (const t of model.tasks) insTask.run(t.id, t.project_id, t.title, t.status, t.created_at, t.updated_at);
  const insRun = db.prepare("insert into runs values (?,?,?,?,?,?)");
  for (const r of model.runs) insRun.run(r.id, r.task_id, r.conversation_id, r.workspace_id, r.status, r.started_at);

  const upsertMirror = db.prepare(
    "insert or replace into live_mirror values (?,?,?,?,?)"
  );

  const byProject = db.prepare(
    "select * from conversations where deleted_at is null and (? is null or project_id = ?) order by updated_at desc"
  );
  const tasksOf = db.prepare("select * from tasks where (? is null or project_id = ?)");
  const mirrorAll = db.prepare("select * from live_mirror");
  const mirrorOf = db.prepare("select * from live_mirror where conversation_id = ?");

  return {
    db,
    /** Confirmed conversation records (7 fields, same as ConversationSchema). */
    conversations(projectId = null) {
      return byProject.all(projectId, projectId).map((r) => ({ ...r, archived: r.archived === 1 }));
    },
    tasks(projectId = null) {
      return tasksOf.all(projectId, projectId);
    },
    /** Write the live fields the projection job is allowed to mirror. Returns rows written. */
    mirror(liveMap, now = Date.now()) {
      let rows = 0;
      for (const [id, s] of liveMap) {
        upsertMirror.run(id, s.status, s.needsReason, s.lastActivityAt, now);
        rows += 1;
      }
      return rows;
    },
    mirreredLive() {
      const out = new Map();
      for (const r of mirrorAll.all()) {
        out.set(r.conversation_id, {
          status: r.status,
          needsReason: r.needs_reason,
          lastActivityAt: r.last_activity_at,
        });
      }
      return out;
    },
    mirrorOf(id) {
      const r = mirrorOf.get(id);
      return r === undefined
        ? null
        : { status: r.status, needsReason: r.needs_reason, lastActivityAt: r.last_activity_at };
    },
  };
}
