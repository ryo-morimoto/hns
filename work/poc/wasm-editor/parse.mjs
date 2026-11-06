// How fast is a WASM JS/TS front end for an editor, against a pure-JS parser?
import { performance } from "node:perf_hooks";
import * as acorn from "acorn";

const lines = [];
for (let i = 0; i < 4000; i++) {
  lines.push(`export function fn${i}(a, b) { const x = a + b * ${i}; return x > 0 ? x : -x; }`);
}
const source = lines.join("\n");
const bytes = Buffer.byteLength(source);

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const time = (fn, runs = 7) => { fn(); const out = []; for (let i = 0; i < runs; i++) { const t = performance.now(); fn(); out.push(performance.now() - t); } return median(out); };

// 1. acorn (pure JS)
const acornMs = time(() => acorn.parse(source, { ecmaVersion: 2022, sourceType: "module" }));

// 2. @swc/wasm (Rust compiled to WASM): parse + transform + codegen
const importStart = performance.now();
const swc = await import("@swc/wasm");
const importMs = performance.now() - importStart;
const transform = (s) => swc.transformSync(s, { jsc: { parser: { syntax: "ecmascript" }, target: "es2022" }, filename: "x.js" });
const swcMs = time(() => transform(source));

// 3. tree-sitter WASM: record what fails today
let treeSitter;
try {
  const { Parser, Language } = await import("web-tree-sitter");
  await Parser.init();
  const { join } = await import("node:path");
  await Language.load(join(process.cwd(), "node_modules/tree-sitter-wasms/out/tree-sitter-javascript.wasm"));
  treeSitter = "loaded";
} catch (error) {
  treeSitter = "error: " + String(error?.message ?? error).split("\n")[0] + " (grammar ABI likely newer than web-tree-sitter)";
}

const result = { bytes, lines: lines.length, acornMs, swcImportMs: importMs, swcMs, treeSitter };
console.log(JSON.stringify(result, null, 2));
