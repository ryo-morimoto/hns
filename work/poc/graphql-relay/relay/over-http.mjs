// Relay over the GraphQL server from ../src, with NO D1 mirror at all.
// Measures: HTTP requests, DO RPCs, and D1 mirror writes (must stay 0).
import relayRuntime from "relay-runtime";
import { seedModel } from "../src/model.mjs";
import { createProjection } from "../src/projection.mjs";
import { startSession } from "../src/session.mjs";
import { startGql } from "../src/gql.mjs";
import SidebarQuery from "./src/__generated__/SidebarQuery.graphql.js";
import PanelQuery from "./src/__generated__/PanelQuery.graphql.js";
import OverviewQuery from "./src/__generated__/OverviewQuery.graphql.js";

const { Environment, Network, Store, RecordSource, fetchQuery } = relayRuntime;

const model = seedModel();
const projection = createProjection(model);

// The mirror is never populated. Any write would be a bug for this experiment.
let mirrorWrites = 0;
const originalMirror = projection.mirror;
projection.mirror = (...args) => {
  mirrorWrites += 1;
  return originalMirror(...args);
};

const wsConversations = new Map();
for (const w of model.workspaces) wsConversations.set(w.id, []);
for (const c of model.conversations) wsConversations.get(c.projectId ?? c.project_id).push(c.id);

const sessions = new Map();
for (const w of model.workspaces) {
  const states = model.conversations.filter((c) => c.project_id === w.id).map((c) => [c.id, model.live.get(c.id)]);
  sessions.set(w.id, await startSession({ wsId: w.id, states }));
}
const gql = await startGql({ projection, sessions, wsConversations });

const rpcTotal = () => [...sessions.values()].reduce((n, s) => n + s.rpcCount, 0);

let mode = "batch";
let httpCalls = 0;
const network = Network.create(async (params, variables) => {
  httpCalls += 1;
  const res = await fetch(gql.url + "/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: params.text, variables, mode }),
  });
  return res.json();
});

const environment = new Environment({ network, store: new Store(new RecordSource()) });

function fetchRelay(query, variables, options) {
  return new Promise((resolve, reject) => {
    let value;
    fetchQuery(environment, query, variables, options).subscribe({
      next: (v) => { value = v; },
      error: reject,
      complete: () => resolve(value),
    });
  });
}

const rows = [];
async function step(label, fn) {
  const httpBefore = httpCalls;
  const rpcBefore = rpcTotal();
  await fn();
  rows.push({ label, http: httpCalls - httpBefore, rpc: rpcTotal() - rpcBefore });
}

const CACHE = { fetchPolicy: "store-or-network" };
const v = { projectId: "p-01" };

await step("sidebar, first load (batch, no mirror)", () => fetchRelay(SidebarQuery, v, CACHE));
await step("sidebar, opened again", () => fetchRelay(SidebarQuery, v, CACHE));
await step("panel (needs live, not in store yet)", () => fetchRelay(PanelQuery, v, CACHE));
await step("panel, opened again", () => fetchRelay(PanelQuery, v, CACHE));
let firstOverview;
await step("overview screen (home), first load", async () => {
  firstOverview = await fetchRelay(OverviewQuery, {}, CACHE);
});
await step("overview, opened again", () => fetchRelay(OverviewQuery, {}, CACHE));
mode = "fanout";
await step("sidebar, isolated refetch (fan-out)", () => fetchRelay(SidebarQuery, v, { fetchPolicy: "network-only" }));
await step("panel, isolated refetch (fan-out)", () => fetchRelay(PanelQuery, v, { fetchPolicy: "network-only" }));

console.log("scenario".padEnd(46) + "http   DO RPC");
for (const r of rows) console.log(r.label.padEnd(46) + String(r.http).padStart(4) + String(r.rpc).padStart(8));
console.log("");
const needs = firstOverview?.overview?.needs?.length ?? 0;
console.log("overview needs rendered without any mirror:", needs);
console.log("mirror writes during the whole run:", mirrorWrites);
console.log("store records:", Object.keys(environment.getStore().getSource().toJSON()).length);

await gql.close();
await Promise.all([...sessions.values()].map((s) => s.close()));
