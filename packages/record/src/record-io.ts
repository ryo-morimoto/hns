import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { parse, stringify } from "yaml";
import * as v from "valibot";

import { deriveDoneLevel } from "./derive.ts";
import { validateRecord, workRecordSchema } from "./schema.ts";
import type { RecordIssue } from "./schema.ts";
import type { DoneLevel, WorkRecord } from "./types.ts";

/** The result of reading or parsing one record. */
export type RecordResult =
  | { readonly ok: true; readonly record: WorkRecord; readonly level: DoneLevel }
  | {
      readonly ok: false;
      readonly kind: "read" | "invalid";
      readonly issues: readonly RecordIssue[];
    };

/** One record as a progress consumer sees it. Invalid records keep their issues. */
export interface RecordSummary {
  /** Absolute or relative path to the YAML file. */
  readonly file: string;
  /** Issue number from the file name. */
  readonly issue: string;
  /** Derived level, or null when the file is invalid. */
  readonly level: DoneLevel | null;
  /** Criteria that passed. */
  readonly passed: number;
  /** Criteria in the record. */
  readonly total: number;
  /** Why the file is invalid. Empty when it parsed. */
  readonly issues: readonly RecordIssue[];
}

const failure = (kind: "read" | "invalid", path: string, message: string): RecordResult => ({
  ok: false,
  kind,
  issues: [{ path, message }],
});

/**
 * Parse and validate one YAML record.
 *
 * @param text - The YAML document.
 * @returns The record and its derived level, or every issue found.
 */
export const parseRecordText = (text: string): RecordResult => {
  let value: unknown;
  try {
    value = parse(text);
  } catch (error) {
    return failure("invalid", "/", error instanceof Error ? error.message : "invalid YAML");
  }
  const parsed = v.safeParse(workRecordSchema, value);
  if (!parsed.success) {
    return {
      ok: false,
      kind: "invalid",
      issues: parsed.issues.map((issue) => ({
        path: issue.path?.map((item) => String(item.key)).join(".") ?? "/",
        message: issue.message,
      })),
    };
  }
  const issues = validateRecord(parsed.output);
  if (issues.length > 0) return { ok: false, kind: "invalid", issues };
  return { ok: true, record: parsed.output, level: deriveDoneLevel(parsed.output) };
};

/**
 * Format one record as YAML.
 *
 * @param record - A record, valid or draft.
 * @returns YAML with a stable shape.
 */
export const formatRecord = (record: WorkRecord): string => stringify(record, { lineWidth: 0 });

/**
 * Read one record file.
 *
 * @remarks
 * The file name must be NNNN.yaml and its NNNN must match the record issue.
 * @param file - Path to a YAML file.
 * @returns The parsed record or a read/parse issue.
 */
export const readRecordFile = async (file: string): Promise<RecordResult> => {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return failure("read", file, error instanceof Error ? error.message : "cannot read file");
  }
  const result = parseRecordText(text);
  if (!result.ok) return result;
  const expected = basename(file).replace(/\.yaml$/u, "");
  if (expected !== result.record.issue) {
    return {
      ok: false,
      kind: "invalid",
      issues: [{ path: "issue", message: "issue must match the file name: " + expected }],
    };
  }
  return result;
};

/**
 * Write one record file, creating its directory.
 *
 * @param file - Destination path.
 * @param record - The record to write.
 */
export const writeRecordFile = async (file: string, record: WorkRecord): Promise<void> => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, formatRecord(record), "utf8");
};

/**
 * List YAML files in a directory, sorted.
 *
 * @param dir - Directory holding the records.
 * @returns File paths, sorted by name.
 */
export const listRecordFiles = async (dir: string): Promise<readonly string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".yaml")) files.push(join(dir, entry.name));
  }
  return files.sort();
};

/**
 * Read every record in a directory.
 *
 * @param dir - Directory holding the records.
 * @returns One summary per file, including invalid ones.
 */
export const readRecordDir = async (dir: string): Promise<readonly RecordSummary[]> => {
  const files = await listRecordFiles(dir);
  const summaries: RecordSummary[] = [];
  for (const file of files) {
    const result = await readRecordFile(file);
    const issue = basename(file).replace(/\.yaml$/u, "");
    if (!result.ok) {
      summaries.push({ file, issue, level: null, passed: 0, total: 0, issues: result.issues });
      continue;
    }
    let passed = 0;
    for (const criterion of result.record.criteria) {
      if (criterion.status === "passed") passed += 1;
    }
    summaries.push({
      file,
      issue,
      level: result.level,
      passed,
      total: result.record.criteria.length,
      issues: [],
    });
  }
  return summaries;
};
