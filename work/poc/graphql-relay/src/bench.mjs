import { readFileSync, writeFileSync } from "node:fs";
import { seedModel } from "./model.mjs";
import { createProjection } from "./projection.mjs";
import { startSession } from "./session.mjs";
import { startRest } from "./rest.mjs";
import { startGql, SDL } from "./gql.mjs";
import gqlPkg from "graphql";

const ITERS = Number(process.env.ITERS ?? 200);
const WARM = 20;
const MIRROR_MS = Number(process.env.MIRROR_MS ?? 1000);
const TICK_SAMPLE = 3;

const OVERVIEW = `query Overview {
  overview {
    counts { needsYou running doneToday }
    needs { kind id title reason updatedAt }
    running { kind id title reason updatedAt }
    completed { kind id title reason updatedAt }
    asOf
  }
}`;

const CONV_LIVE = `query ConvsWithLive {
  conversations {
    id title updatedAt
    live { status needsReason lastActivityAt }
  }
}`;

const SIDEBAR = `query Sidebar { conversations(projectId: "p-01") { id title updatedAt archived } }`;

const CONV_LIVE_7 = `query ConvsLive7 {
  conversations {
    id projectId title createdAt updatedAt archived deletedAt
    live { status needsReason lastActivityAt }
  }
}`;

const CONV_LIVE_4 = `query ConvsLive4 {
  conversations {
    id title updatedAt archived
    live { status needsReason lastActivityAt }
  }
}`;

const CONVS = Number(process.env.CONVS ?? 40);
const model = seedModel({ conversations: CONVS });
const projection = createProjection(model);
const wsConversations = new Map();
for (const w of model.workspaces) wsConversations.set(w.id, []);
for (const c of model.conversations) wsConversations.get(c.project_id).push(c.id);

const sessions = new Map();
for (const w of model.workspaces) {
  const states = model.conversations.filter((c) => c.project_id === w.id).map((c) => [c.id, model.live.get(c.id)]);
  sessions.set(w.id, await startSession({ wsId: w.id, states }));
}

async function mirrorFromSessions() {
  const live = new Map();
  for (const s of sessions.values()) {
    const res = await fetch(s.url + "/rpc/all", { method: "POST", body: "{}" });
    const { states } = await res.json();
    for (const [id, state] of Object.entries(states)) live.set(id, state);
  }
  return projection.mirror(live);
}
await mirrorFromSessions();
let mirrorRows = 0;
let mirrorTimer = null;
const startMirror = () => {
  mirrorTimer = setInterval(() => {
    void mirrorFromSessions().then((rows) => { mirrorRows += rows; });
  }, MIRROR_MS);
};
const stopMirror = () => {
  if (mirrorTimer !== null) {
    clearInterval(mirrorTimer);
    mirrorTimer = null;
  }
};

const rest = await startRest({ projection, sessions, wsConversations, model });
const gql = await startGql({ projection, sessions, wsConversations });

const convIds = model.conversations.map((c) => c.id);
const rpcTotal = () => [...sessions.values()].reduce((n, s) => n + s.rpcCount, 0);

async function getJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (res.status !== 200) throw new Error("HTTP " + res.status + " " + text);
  return { bytes: Buffer.byteLength(text), value: JSON.parse(text) };
}

async function postGql(query, mode) {
  const res = await fetch(gql.url + "/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, mode }),
  });
  const text = await res.text();
  const value = JSON.parse(text);
  if (value.errors !== undefined) throw new Error(JSON.stringify(value.errors));
  return { bytes: Buffer.byteLength(text), value };
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return { p50: at(50), p95: at(95), min: s[0], max: s[s.length - 1] };
}

const results = [];
async function measure(label, requests, fn, note = "") {
  for (let i = 0; i < WARM; i++) await fn();
  const times = [];
  let bytes = 0;
  let items = 0;
  const rpcBefore = rpcTotal();
  for (let i = 0; i < ITERS; i++) {
    const t = process.hrtime.bigint();
    const out = await fn();
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
    bytes += out.bytes;
    items = out.items ?? items;
  }
  const rpc = rpcTotal() - rpcBefore;
  const row = { label, clientRequests: requests, rpcPerRequest: Number((rpc / ITERS).toFixed(2)), latencyMs: stats(times), bytesPerScreen: Math.round(bytes / ITERS), items, note };
  results.push(row);
  console.log(
    label.padEnd(52) +
      "req=" + String(requests).padEnd(3) +
      "rpc=" + String(row.rpcPerRequest).padEnd(6) +
      "p50=" + row.latencyMs.p50.toFixed(2).padStart(7) +
      "p95=" + row.latencyMs.p95.toFixed(2).padStart(7) +
      "bytes=" + String(row.bytesPerScreen).padStart(6),
  );
  return row;
}

console.log("");
console.log("== Home overview screen: " + model.workspaces.length + " workspaces / " + CONVS + " conversations ==");
await measure("REST  /api/state per conversation (N+1)", convIds.length, async () => {
  const out = await Promise.all(convIds.map((id) => getJson(rest.url + "/api/state?conversationId=" + id)));
  return { bytes: out.reduce((n, o) => n + o.bytes, 0), items: convIds.length };
});
await measure("REST  /api/live per conversation (N+1, lean)", convIds.length, async () => {
  const out = await Promise.all(convIds.map((id) => getJson(rest.url + "/api/live?conversationId=" + id)));
  return { bytes: out.reduce((n, o) => n + o.bytes, 0), items: convIds.length };
});
await measure("REST  /api/overview  (RPC batched per workspace)", 1, async () => {
  const o = await getJson(rest.url + "/api/overview");
  return { bytes: o.bytes, items: o.value.needs.length };
});
await measure("REST  /api/overview  (RPC per conversation, parallel)", 1, async () => {
  const o = await getJson(rest.url + "/api/overview-per-conversation");
  return { bytes: o.bytes, items: o.value.needs.length };
});
await measure("REST  /api/overview  (RPC per conversation, serial)", 1, async () => {
  const o = await getJson(rest.url + "/api/overview-serial");
  return { bytes: o.bytes, items: o.value.needs.length };
});
await measure("REST  /api/overview  (D1 mirror only)", 1, async () => {
  const o = await getJson(rest.url + "/api/overview-mirror");
  return { bytes: o.bytes, items: o.value.needs.length };
});
await measure("GQL   overview (fan-out: RPC per conversation)", 1, async () => {
  const o = await postGql(OVERVIEW, "fanout");
  return { bytes: o.bytes, items: o.value.data.overview.needs.length };
});
await measure("GQL   overview (batch: RPC per workspace)", 1, async () => {
  const o = await postGql(OVERVIEW, "batch");
  return { bytes: o.bytes, items: o.value.data.overview.needs.length };
});
await measure("GQL   overview (D1 mirror only)", 1, async () => {
  const o = await postGql(OVERVIEW, "d1");
  return { bytes: o.bytes, items: o.value.data.overview.needs.length };
});
await measure("REST  /api/overview  (records only, no live)", 1, async () => {
  const o = await getJson(rest.url + "/api/overview-records");
  return { bytes: o.bytes, items: o.value.needs.length };
});
await measure("GQL   overview (records only, no live)", 1, async () => {
  const o = await postGql(OVERVIEW, "records");
  return { bytes: o.bytes, items: o.value.data.overview.needs.length };
});

await measure("REST  /api/conversations?includeLive=1 (batched)", 1, async () => {
  const o = await getJson(rest.url + "/api/conversations?includeLive=1");
  return { bytes: o.bytes, items: o.value.length };
});

console.log("");
console.log("== conversations + per-row live field (" + CONVS + " rows) ==");
await measure("REST  /api/conversations?fields=summary&includeLive=1", 1, async () => {
  const o = await getJson(rest.url + "/api/conversations?fields=summary&includeLive=1");
  return { bytes: o.bytes, items: o.value.length };
});
await measure("GQL   conversations + live (4 fields, batch)", 1, async () => {
  const o = await postGql(CONV_LIVE_4, "batch");
  return { bytes: o.bytes, items: o.value.data.conversations.length };
});
await measure("GQL   conversations + live (7 fields, batch)", 1, async () => {
  const o = await postGql(CONV_LIVE_7, "batch");
  return { bytes: o.bytes, items: o.value.data.conversations.length };
});
await measure("GQL   conversations + live (fan-out)", 1, async () => {
  const o = await postGql(CONV_LIVE, "fanout");
  return { bytes: o.bytes, items: o.value.data.conversations.length };
});
await measure("GQL   conversations + live (batch)", 1, async () => {
  const o = await postGql(CONV_LIVE, "batch");
  return { bytes: o.bytes, items: o.value.data.conversations.length };
});
await measure("GQL   conversations + live (D1 mirror only)", 1, async () => {
  const o = await postGql(CONV_LIVE, "d1");
  return { bytes: o.bytes, items: o.value.data.conversations.length };
});

console.log("");
console.log("== sidebar: 4 of 7 Conversation fields, one project ==");
const sidebarRest = await measure("REST  /api/conversations (7 fields)", 1, async () => {
  const o = await getJson(rest.url + "/api/conversations?projectId=p-01");
  return { bytes: o.bytes, items: o.value.length };
});
const sidebarGql = await measure("GQL   sidebar (4 fields, no live)", 1, async () => {
  const o = await postGql(SIDEBAR, "batch");
  return { bytes: o.bytes, items: o.value.data.conversations.length };
});
await measure("REST  /api/conversations?fields=summary (4)", 1, async () => {
  const o = await getJson(rest.url + "/api/conversations?projectId=p-01&fields=summary");
  return { bytes: o.bytes, items: o.value.length };
});
await measure("GQL   sidebar (7 fields, no live)", 1, async () => {
  const o = await postGql(
    'query Sidebar7 { conversations(projectId: "p-01") { id projectId title createdAt updatedAt archived deletedAt } }',
    "batch",
  );
  return { bytes: o.bytes, items: o.value.data.conversations.length };
});

const authoritative = (await getJson(rest.url + "/api/overview")).value;
const d1View = (await postGql(OVERVIEW, "d1")).value.data.overview;
const recordsView = (await postGql(OVERVIEW, "records")).value.data.overview;
const liveReasons = new Set(["waiting_human", "run_failed", "conversation_blocked", "conversation_aborted", "conversation_incomplete"]);
const authNeedsLive = authoritative.needs.filter((n) => liveReasons.has(n.reason)).length;
const d1NeedsLive = d1View.needs.filter((n) => liveReasons.has(n.reason)).length;

const lags = [];
startMirror();
for (let trial = 0; trial < 6; trial++) {
  const id = convIds[trial];
  const session = sessions.get(model.conversations[trial].project_id);
  const sentinel = "conversation_aborted";
  await new Promise((r) => setTimeout(r, Math.floor(Math.random() * MIRROR_MS)));
  const prev = projection.mirrorOf(id);
  session.setLive(id, { status: "blocked", needsReason: sentinel, lastActivityAt: new Date().toISOString() });
  const t0 = Date.now();
  let seen = null;
  while (Date.now() - t0 < MIRROR_MS * 3) {
    const m = projection.mirrorOf(id);
    if (m !== null && m.needsReason === sentinel) { seen = m; break; }
    await new Promise((r) => setTimeout(r, 5));
  }
  lags.push(seen === null ? null : Date.now() - t0);
  session.setLive(id, { status: "idle", needsReason: null, lastActivityAt: prev === null ? null : prev.lastActivityAt });
}
stopMirror();

const schema = gqlPkg.buildSchema(SDL);
const staticRoot = {
  overview: () => ({
    counts: { needsYou: 8, running: 10, doneToday: 20 },
    needs: Array.from({ length: 8 }, (_, i) => ({ kind: "conversation", id: "c-" + i, title: "t" + i, reason: "waiting_human", updatedAt: new Date().toISOString() })),
    running: Array.from({ length: 10 }, (_, i) => ({ kind: "conversation", id: "r-" + i, title: "t" + i, reason: null, updatedAt: new Date().toISOString() })),
    completed: Array.from({ length: 20 }, (_, i) => ({ kind: "task", id: "d-" + i, title: "t" + i, reason: null, updatedAt: new Date().toISOString() })),
    asOf: new Date().toISOString(),
  }),
};
const fixed = [];
for (let i = 0; i < 300; i++) {
  const t = process.hrtime.bigint();
  await gqlPkg.graphql({ schema, source: OVERVIEW, rootValue: staticRoot });
  fixed.push(Number(process.hrtime.bigint() - t) / 1e6);
}
const doc = gqlPkg.parse(OVERVIEW);
const pv = [];
for (let i = 0; i < 300; i++) {
  const t = process.hrtime.bigint();
  gqlPkg.validate(schema, doc);
  pv.push(Number(process.hrtime.bigint() - t) / 1e6);
}

const loc = (p) => readFileSync(new URL(p, import.meta.url), "utf8").split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("//")).length;
const sizes = {
  "rest.mjs": loc("./rest.mjs"),
  "gql.mjs": loc("./gql.mjs"),
  "compose.mjs (business rules, shared)": loc("./compose.mjs"),
  "SDL lines": SDL.split("\n").filter((l) => l.trim() !== "").length,
};

// D1 write volume of the projection job, measured over a window.
const mirrorRowsAtStart = mirrorRows;
let ticks = 0;
await new Promise((resolve) => {
  const timer = setInterval(() => {
    void mirrorFromSessions().then((rows) => {
      mirrorRows += rows;
      ticks += 1;
      if (ticks === TICK_SAMPLE) {
        clearInterval(timer);
        resolve();
      }
    });
  }, MIRROR_MS);
});
const rowsPerTick = (mirrorRows - mirrorRowsAtStart) / ticks;
const rowsPerSecond = (rowsPerTick * 1000) / MIRROR_MS;
const rowsPerDay = Math.round(rowsPerSecond * 86400);
await Promise.all([rest.close(), gql.close(), ...[...sessions.values()].map((s) => s.close())]);

const report = {
  generatedAt: new Date().toISOString(),
  config: { iters: ITERS, warmup: WARM, mirrorMs: MIRROR_MS, workspaces: model.workspaces.length, conversations: CONVS, node: process.version },
  results,
  sidebar: { rest: sidebarRest, gql: sidebarGql },
  needs: { authoritative: authoritative.needs.length, needsFromLiveOnly: authNeedsLive, d1Representable: d1View.needs.length, d1NeedsFromLiveOnly: d1NeedsLive, recordsOnly: recordsView.needs.length },
  mirror: { intervalMs: MIRROR_MS, ticks, rowsPerTick, rowsPerSecond: Number(rowsPerSecond.toFixed(2)), rowsPerDay },
  mirrorLagMs: lags,
  graphqlFixedCostMs: stats(fixed),
  graphqlValidateMs: stats(pv),
  loc: sizes,
};
writeFileSync(new URL("../results-" + CONVS + ".json", import.meta.url), JSON.stringify(report, null, 2));

console.log("");
console.log("== needs ==");
console.log("authoritative:", authoritative.needs.length, "| live-only reasons:", authNeedsLive, "| D1 mirror sees:", d1View.needs.length, "| records-only sees:", recordsView.needs.length);
console.log("== D1 mirror lag ms (MIRROR_MS=" + MIRROR_MS + ") ==", lags.map((v) => (v === null ? "timeout" : v)).join(", "));
console.log("== graphql-js fixed cost, no I/O (ms) ==", JSON.stringify(stats(fixed)));
console.log("== graphql-js validate only (ms) ==", JSON.stringify(stats(pv)));
console.log("== D1 mirror write volume ==", JSON.stringify(report.mirror));
console.log("== LOC ==", JSON.stringify(sizes));
console.log("wrote results.json");
