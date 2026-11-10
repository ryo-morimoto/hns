import relayRuntime from "relay-runtime";

const { Environment, Network, Store, RecordSource, fetchQuery } = relayRuntime;
import SidebarQuery from "./src/__generated__/SidebarQuery.graphql.js";
import PanelQuery from "./src/__generated__/PanelQuery.graphql.js";
import TitleOnlyQuery from "./src/__generated__/TitleOnlyQuery.graphql.js";

const iso = "2026-11-10T00:00:00.000Z";
const rows = Array.from({ length: 40 }, (_, i) => ({
  id: "c-" + i,
  projectId: "p-01",
  title: "conversation " + i,
  createdAt: iso,
  updatedAt: iso,
  archived: false,
  live: { status: i < 10 ? "running" : "idle", needsReason: i < 6 ? "waiting_human" : null, lastActivityAt: iso },
}));

let calls = 0;
const network = Network.create(() => {
  calls += 1;
  return Promise.resolve({ data: { conversations: rows } });
});

const environment = new Environment({
  network,
  store: new Store(new RecordSource()),
});

function fetch(query, variables, options) {
  return new Promise((resolve, reject) => {
    let value;
    try {
      const obs = fetchQuery(environment, query, variables, options);
      obs.subscribe({
        next: (v) => { value = v; },
        error: reject,
        complete: () => resolve(value),
      });
    } catch (e) {
      reject(e);
    }
  });
}

const report = [];
async function step(label, fn) {
  const before = calls;
  await fn();
  report.push({ label, networkCalls: calls - before });
}

const v = { projectId: "p-01" };
const CACHE = { fetchPolicy: "store-or-network" };

await step("sidebar, store-or-network", () => fetch(SidebarQuery, v, CACHE));
await step("sidebar again (same op)", () => fetch(SidebarQuery, v, CACHE));
await step("title-only op (fields already fetched)", () => fetch(TitleOnlyQuery, v, CACHE));
await step("panel op (needs live, not fetched)", () => fetch(PanelQuery, v, CACHE));
await step("panel again", () => fetch(PanelQuery, v, CACHE));
await step("sidebar with the default policy", () => fetch(SidebarQuery, v));
await step("sidebar with the default policy again", () => fetch(SidebarQuery, v));

console.log("scenario".padEnd(46) + "network calls");
for (const r of report) console.log(r.label.padEnd(46) + r.networkCalls);
console.log("");
console.log("total network calls:", calls);
console.log("store records:", Object.keys(environment.getStore().getSource().toJSON()).length);
