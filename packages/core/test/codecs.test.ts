import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { isoTimestamp, operationId, operationIdFrom } from "../src/index.ts";

test("ISO timestamps are built only through the codec", () => {
  const value = isoTimestamp("2026-01-01T00:00:00.000Z");
  assert.equal(value, "2026-01-01T00:00:00.000Z");
  assert.throws(() => isoTimestamp("2026-01-01"));
  assert.throws(() => isoTimestamp("not-a-date"));
});

test("operation ids are built only through the codec", () => {
  assert.equal(operationId("call-1"), "call-1");
  assert.throws(() => operationId("bad id"));
  assert.throws(() => operationId(""));
  assert.throws(() => operationId("x".repeat(65)));
});

// Catches: a derived id kept a character the wire format refuses, or ran past its length.
test("operation ids are derived from arbitrary text inside the rule", () => {
  assert.equal(operationIdFrom("tool:1793:qwe"), "tool-1793-qwe");
  assert.equal(operationIdFrom("a".repeat(100)).length, 64);
  assert.throws(() => operationIdFrom(""));
});

// Catches: a copy of the ISO validator or of the operationId alphabet outside the codec.
// A text scan: it cannot see a rule retyped in another form, so the claim stays this narrow.
test("the codec's ISO and operationId literals are not repeated outside codecs.ts", async () => {
  const root = join(import.meta.dirname, "../../..");
  const sourceFiles = await readdir(join(root, "packages"), {
    recursive: true,
    withFileTypes: true,
  });
  const offenders: string[] = [];
  for (const entry of sourceFiles) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const path = join(entry.parentPath ?? "", entry.name);
    if (!path.includes("/src/") || path.endsWith("/packages/core/src/codecs.ts")) continue;
    const text = await readFile(path, "utf8");
    const code = text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/.*$/gm, "");
    if (code.includes("v.isoTimestamp") || code.includes("A-Za-z0-9_-")) {
      offenders.push(path.slice(root.length + 1));
    }
  }
  assert.deepEqual(offenders, []);
});
