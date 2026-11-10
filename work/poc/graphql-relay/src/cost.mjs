// Cost model for the two stores this architecture depends on.
// Rates read from the Cloudflare docs on 2026-11-10 (pages last updated 2026-10-18 / 2026-10-30).
// Every input is a measured number or an explicit parameter; nothing here is inferred from pricing pages twice.
import { readFileSync } from "node:fs";

const P = {
  // Durable Objects, Workers Paid
  doRequestIncluded: 1_000_000,
  doRequestPerM: 0.15,
  doDurationIncluded: 400_000, // GB-s
  doDurationPerM: 12.5,
  // D1 and DO SQLite share these rates (DO pricing points at D1 pricing)
  rowsReadIncluded: 25_000_000_000,
  rowsReadPerM: 0.001,
  rowsWrittenIncluded: 50_000_000,
  rowsWrittenPerM: 1.0,
  d1StorageIncludedGb: 5,
  d1StoragePerGb: 0.75,
  doStoragePerGb: 0.2,
  secondsPerMonth: 2_592_000,
  // measured in cf-harness: DO RPC p50
  rpcMs: 28,
  // DO bills 128 MiB per second of duration
  gbPerDo: 0.125,
};

const charge = (used, included, perM) => Math.max(0, used - included) / 1_000_000 * perM;
const usd = (n) => "$" + n.toFixed(2);

const results = {
  40: JSON.parse(readFileSync(new URL("../results-40.json", import.meta.url), "utf8")),
  120: JSON.parse(readFileSync(new URL("../results-120.json", import.meta.url), "utf8")),
};

console.log("== 1. D1 rows written by mirroring live state ==");
console.log("   policy: full snapshot every interval (what the bench measures)");
console.log("   convs  interval   rows/month      D1 $/month");
const intervals = [1, 2, 5, 10, 60];
for (const c of [40, 120]) {
  for (const i of intervals) {
    const rows = (c / i) * P.secondsPerMonth;
    console.log(
      "   " + String(c).padStart(4) + "   " + String(i + "s").padStart(7) +
      String(Math.round(rows).toLocaleString("en-US")).padStart(16) +
      usd(charge(rows, P.rowsWrittenIncluded, P.rowsWrittenPerM)).padStart(14),
    );
  }
}
console.log("");
console.log("   measured, for the same policies:");
for (const c of [40, 120]) {
  const m = results[c].mirror;
  console.log("   " + c + " convs: " + m.rowsPerTick + " rows/tick, " + m.rowsPerSecond + " rows/s, " + m.rowsPerDay.toLocaleString("en-US") + " rows/day (measured)");
}

console.log("");
console.log("== 2. D1 rows written by dirty-set mirroring (only what changed) ==");
console.log("   convs  changes/conv/hour   rows/month   D1 $/month");
for (const c of [40, 120]) {
  for (const ch of [1, 6, 60]) {
    const rows = c * ch * 24 * 30;
    console.log(
      "   " + String(c).padStart(4) + "   " + String(ch).padStart(17) +
      String(Math.round(rows).toLocaleString("en-US")).padStart(13) +
      usd(charge(rows, P.rowsWrittenIncluded, P.rowsWrittenPerM)).padStart(13),
    );
  }
}

console.log("");
console.log("== 3. DO requests + duration per screen load ==");
const loads = [6_000, 60_000, 300_000];
const paths = [
  { label: "batched (12 RPC)", rpc: 12, readRows: 0 },
  { label: "per conversation (40 RPC)", rpc: 40, readRows: 0 },
  { label: "per conversation (120 RPC)", rpc: 120, readRows: 0 },
  { label: "mirror, 0 RPC", rpc: 0, readRows: 100 },
];
console.log("   loads/month  path                       DO req $   DO duration $   D1 rows read $   total $");
for (const l of loads) {
  for (const p of paths) {
    const req = p.rpc * l;
    const durGbS = p.rpc * (P.rpcMs / 1000) * P.gbPerDo * l;
    const rowsRead = p.readRows * l;
    const reqCost = charge(req, P.doRequestIncluded, P.doRequestPerM);
    const durCost = charge(durGbS, P.doDurationIncluded, P.doDurationPerM);
    const readCost = charge(rowsRead, P.rowsReadIncluded, P.rowsReadPerM);
    console.log(
      "   " + String(l.toLocaleString("en-US")).padStart(12) + "  " + p.label.padEnd(26) +
      usd(reqCost).padStart(10) + usd(durCost).padStart(16) + usd(readCost).padStart(16) +
      usd(reqCost + durCost + readCost).padStart(11),
    );
  }
}

console.log("");
console.log("== 3b. the mirror job's own DO requests (it polls every Session) ==");
const workspaces = 12;
console.log("   workspaces  interval   DO req/month      DO \$   + D1 writes \$ (40 conv)   total \$");
for (const i of intervals) {
  const req = workspaces * (P.secondsPerMonth / i);
  const d1 = charge((40 / i) * P.secondsPerMonth, P.rowsWrittenIncluded, P.rowsWrittenPerM);
  const doCost = charge(req, P.doRequestIncluded, P.doRequestPerM);
  console.log(
    "   " + String(workspaces).padStart(10) + "  " + String(i + "s").padStart(7) +
      String(Math.round(req).toLocaleString("en-US")).padStart(15) +
      usd(doCost).padStart(9) + usd(d1).padStart(25) + usd(doCost + d1).padStart(12),
  );
}

console.log("");
console.log("== 4. thresholds ==");
const rowsForDollars = (d) => P.rowsWrittenIncluded + (d / P.rowsWrittenPerM) * 1_000_000;
for (const d of [0, 1, 50, 100]) {
  const rows = rowsForDollars(d);
  const convsAt1s = (rows / P.secondsPerMonth) * 1;
  console.log("   $" + String(d).padStart(3) + "/month of D1 writes = " + Math.round(rows).toLocaleString("en-US") + " rows/month = " + Math.round(convsAt1s) + " conversations mirrored every 1s (or " + Math.round(convsAt1s / 5) + " every 5s)");
}
const freeRows = 100_000; // D1 free plan rows written / day
console.log("   D1 free plan is 100,000 rows written/day = " + Math.round(freeRows * 30).toLocaleString("en-US") + " rows/month; the 40-conversation 1s mirror is " + Math.round(40 * 86400).toLocaleString("en-US") + " rows/day (" + (40 * 86400 / freeRows).toFixed(1) + "x that limit)");

console.log("");
console.log("== 5. DO WebSocket (0159) ==");
console.log("   connection = 1 request; outgoing messages free; incoming billed at 20:1");
console.log("   a 10/s upstream stream, 8h/day = " + Math.round(10 * 3600 * 8 * 30 / 20).toLocaleString("en-US") + " billed requests/month = " + usd(charge(10 * 3600 * 8 * 30 / 20, P.doRequestIncluded, P.doRequestPerM)));
