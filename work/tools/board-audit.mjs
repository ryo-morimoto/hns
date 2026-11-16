#!/usr/bin/env node
// Audit the BOARD's derived lists against issue frontmatter. Run: node work/tools/board-audit.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "work/issues";
const field = (text, name) => text.match(new RegExp("^" + name + ": *(.*)$", "m"))?.[1]?.trim() ?? "";
const issues = new Map();
for (const file of readdirSync(DIR)) {
  if (!file.endsWith(".md")) continue;
  const text = readFileSync(join(DIR, file), "utf8");
  issues.set(file.slice(0, 4), {
    status: field(text, "status"),
    priority: field(text, "priority"),
    design: field(text, "design"),
    depends: field(text, "depends-on")
      .split(",")
      .map((s) => s.trim().replace(/[^0-9]/g, ""))
      .filter((s) => s.length === 4),
  });
}
const depsMet = (deps) => deps.every((d) => ["done", "superseded"].includes(issues.get(d)?.status ?? ""));
const open = [...issues.entries()].filter(([, v]) => v.status === "open");
const count = (pred) => open.filter(([, v]) => pred(v)).length;
const ids = (pred) => open.filter(([, v]) => pred(v)).map(([id]) => id).sort().join(", ");
const plan = (v) => v.priority === "next";

console.log(
  ["open=" + open.length, "agreed=" + count((v) => v.design === "agreed"), "pending=" + count((v) => v.design === "pending"),
   "now=" + count((v) => v.priority === "now"), "next=" + count(plan), "later=" + count((v) => v.priority === "later"),
   "parked=" + count((v) => v.priority === "parked")].join(" "),
);
console.log("design-ready: " + ids((v) => plan(v) && v.design === "pending" && depsMet(v.depends)));
console.log("agreed-ready: " + ids((v) => plan(v) && v.design === "agreed" && depsMet(v.depends)));
console.log("dep-wait: " + ids((v) => plan(v) && !depsMet(v.depends)));
