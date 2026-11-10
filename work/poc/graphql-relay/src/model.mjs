// Deterministic seed of the read model, placed as ARCH.md places it:
// confirmed records in the D1-like projection, live state in one Session actor per workspace.
// Product types are copied field-for-field from packages/core/src/http-schemas.ts.

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TITLES = [
  "gate の層を分ける", "journal の切り詰め", "lease の期限", "web の shell",
  "Provider の上限", "checkpoint の再送", "editor の dirty", "passkey の追加",
  "run の中断", "workflow の版", "automation の cron", "file tree の検索",
];

export function seedModel({ workspaces = 12, conversations = 40, tasks = 60, seed = 7 } = {}) {
  const rand = prng(seed);
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();

  const ws = Array.from({ length: workspaces }, (_, i) => ({
    id: "p-" + String(i + 1).padStart(2, "0"),
    name: "project " + String(i + 1),
  }));

  const convs = Array.from({ length: conversations }, (_, i) => {
    const project = ws[i % workspaces];
    return {
      id: "c-" + String(i + 1).padStart(3, "0"),
      project_id: project.id,
      title: TITLES[i % TITLES.length] + " #" + (i + 1),
      created_at: iso(now - 86400000 * (3 + (i % 9))),
      updated_at: iso(now - 60000 * (5 + i * 7)),
      archived: i % 13 === 0,
      deleted_at: null,
    };
  });

  // 8 "Needs you" items over 40 conversations: 3 waiting_human, 2 run_failed,
  // 1 conversation_blocked, and 2 blocked tasks (the only reason the projection can hold).
  const needPlan = [
    "waiting_human", "waiting_human", "waiting_human",
    "run_failed", "run_failed", "conversation_blocked",
  ];
  const live = new Map();
  convs.forEach((c, i) => {
    let status = "idle";
    let needsReason = null;
    if (i < 10) status = "running";
    if (i < needPlan.length) {
      needsReason = needPlan[i];
      status = needsReason === "run_failed" ? "blocked" : "needs_human";
    }
    live.set(c.id, {
      status,
      needsReason,
      lastActivityAt: iso(now - 60000 * (i + 1) + Math.floor(rand() * 1000)),
      queued: i < 6 ? 1 : 0,
    });
  });

  const taskRows = Array.from({ length: tasks }, (_, i) => {
    const blocked = i >= tasks - 2; // exactly 2 blocked tasks
    const done = !blocked && i % 3 === 0;
    return {
      id: "t-" + String(i + 1).padStart(3, "0"),
      project_id: ws[i % workspaces].id,
      title: "task " + (i + 1),
      status: blocked ? "blocked" : done ? "done" : i % 3 === 1 ? "todo" : "doing",
      created_at: iso(now - 86400000 * (2 + (i % 7))),
      updated_at: iso(now - 60000 * (i + 3) * (done ? 1 : 30)),
    };
  });

  const runRows = Array.from({ length: 30 }, (_, i) => ({
    id: "r-" + String(i + 1).padStart(3, "0"),
    task_id: taskRows[i % tasks].id,
    conversation_id: convs[i % conversations].id,
    workspace_id: ws[i % workspaces].id,
    status: i < 4 ? "running" : i % 5 === 0 ? "failed" : "done",
    started_at: iso(now - 3600000 * (i + 1)),
  }));

  return { workspaces: ws, conversations: convs, tasks: taskRows, runs: runRows, live };
}
