import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { isoTimestamp, operationId, operationIdFrom } from "../src/index.ts";

test("ISO timestamps are built only through the codec", () => {
  const value = isoTimestamp("2026-01-01T00:00:00.000Z");
  expect(value).toBe("2026-01-01T00:00:00.000Z");
  expect(() => isoTimestamp("2026-01-01")).toThrow();
  expect(() => isoTimestamp("not-a-date")).toThrow();
});

test("operation ids are built only through the codec", () => {
  expect(operationId("call-1")).toBe("call-1");
  expect(() => operationId("bad id")).toThrow();
  expect(() => operationId("")).toThrow();
  expect(() => operationId("x".repeat(65))).toThrow();
});

// Catches: a derived id kept a character the wire format refuses, or ran past its length.
test("operation ids are derived from arbitrary text inside the rule", () => {
  expect(operationIdFrom("tool:1793:qwe")).toBe("tool-1793-qwe");
  expect(operationIdFrom("a".repeat(100)).length).toBe(64);
  expect(() => operationIdFrom("")).toThrow();
});

// Catches: a copy of the ISO validator or of the operationId alphabet outside the codec.
// A text scan: it cannot see a rule retyped in another form, so the claim stays this narrow.
test("no package source calls v.isoTimestamp or repeats the operationId alphabet", async () => {
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
  expect(offenders).toStrictEqual([]);
});
