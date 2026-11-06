import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { isoTimestamp, operationId } from "../src/index.ts";

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

test("the ISO and operationId rules have one home", async () => {
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
    if (code.includes("v.isoTimestamp") || code.includes("[A-Za-z0-9_-]{1,64}")) {
      offenders.push(path.slice(root.length + 1));
    }
  }
  assert.deepEqual(offenders, []);
});
