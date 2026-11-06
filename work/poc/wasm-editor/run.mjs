// Run both measurements and write results.json.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const runOne = (script) => JSON.parse(execFileSync(process.execPath, [script], { encoding: "utf8" }).trim().split("\n").slice(-1)[0] || "{}");
const parseJson = (script) => JSON.parse(execFileSync(process.execPath, [script], { encoding: "utf8" }));

const results = { parse: parseJson("parse.mjs"), transport: parseJson("transport.mjs"), at: new Date().toISOString() };
writeFileSync("results.json", JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify({ parse: results.parse, sizes: results.transport.sizes, crdt: results.transport.crdt }, null, 2));
