// The 0115 overview shape, composed from confirmed rows plus whatever live map
// the caller has: an RPC result (authoritative) or the D1 mirror (stale).
const REASON_ORDER = {
  waiting_human: 0,
  run_failed: 1,
  task_blocked: 2,
  conversation_blocked: 3,
  conversation_aborted: 4,
  conversation_incomplete: 5,
};

export function composeOverview({ convRows, taskRows, live, now = Date.now() }) {
  const needs = [];
  const running = [];
  const completed = [];

  for (const c of convRows) {
    const s = live.get(c.id);
    if (s === undefined) continue;
    if (s.needsReason !== null) {
      needs.push({
        kind: "conversation",
        id: c.id,
        title: c.title,
        reason: s.needsReason,
        updatedAt: s.lastActivityAt,
      });
    }
    if (s.status === "running") {
      running.push({ kind: "conversation", id: c.id, title: c.title, reason: null, updatedAt: s.lastActivityAt });
    }
  }

  for (const t of taskRows) {
    if (t.status === "blocked") {
      needs.push({ kind: "task", id: t.id, title: t.title, reason: "task_blocked", updatedAt: t.updated_at });
    }
    if (t.status === "done" && now - Date.parse(t.updated_at) < 86400000) {
      completed.push({ kind: "task", id: t.id, title: t.title, reason: null, updatedAt: t.updated_at });
    }
  }

  needs.sort((a, b) => (REASON_ORDER[a.reason] - REASON_ORDER[b.reason]) || a.updatedAt.localeCompare(b.updatedAt));
  running.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  completed.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return {
    counts: { needsYou: needs.length, running: running.length, doneToday: completed.length },
    needs: needs.slice(0, 50),
    running: running.slice(0, 50),
    completed: completed.slice(0, 50),
    asOf: new Date(now).toISOString(),
  };
}
