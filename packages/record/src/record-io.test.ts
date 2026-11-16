import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { baseRecord } from "../test/support/records.ts";
import {
  formatRecord,
  parseRecordText,
  readRecordDir,
  readRecordFile,
  writeRecordFile,
} from "./record-io.ts";

test("format and parse round-trip keeps the record", () => {
  const text = formatRecord(baseRecord());
  const parsed = parseRecordText(text);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.record).toEqual(baseRecord());
  expect(parsed.level).toBe("verified");
});

test("invalid YAML is rejected instead of defaulted", () => {
  const parsed = parseRecordText("issue: [unclosed");
  expect(parsed.ok).toBe(false);
});

test("the file name and the issue must agree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hns-record-"));
  const file = join(dir, "0200.yaml");
  await writeRecordFile(file, { ...baseRecord(), issue: "0199" });
  const parsed = await readRecordFile(file);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.issues[0]?.path).toBe("issue");
});

test("files round-trip through a directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hns-record-"));
  const file = join(dir, "0200.yaml");
  await writeRecordFile(file, baseRecord());
  const parsed = await readRecordFile(file);
  expect(parsed.ok).toBe(true);
  const summaries = await readRecordDir(dir);
  expect(summaries.map((summary) => summary.issue)).toEqual(["0200"]);
  await writeFile(join(dir, "0201.yaml"), "schema: 1\nissue: bad\n", "utf8");
  const withInvalid = await readRecordDir(dir);
  expect(withInvalid.filter((summary) => summary.level === null)).toHaveLength(1);
});
