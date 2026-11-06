import { performance } from "node:perf_hooks";
import { diffLines } from "./diff.mjs";
const run = (label, a, b) => { const t = performance.now(); const r = diffLines(a, b); console.log(label, Math.round(performance.now() - t) + "ms", "+" + r.added, "-" + r.removed); };
const big = (n) => Array.from({ length: n }, (_, i) => "line " + i);
for (const n of [1000, 10000, 100000, 500000]) {
  const a = big(n); const b = [...a]; b[Math.floor(n / 2)] = "changed";
  run("one edit      n=" + n, a.join("\n"), b.join("\n"));
}
const a = big(50000); const b = a.map(x => "x" + x);
run("all changed   n=50000", a.join("\n"), b.join("\n"));
const c = big(100000); const d = [...c]; d.splice(50000, 0, "inserted");
run("insertion     n=100000", c.join("\n"), d.join("\n"));
