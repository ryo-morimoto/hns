import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  formatRecord,
  listRecordFiles,
  readRecordDir,
  readRecordFile,
  writeRecordFile,
} from "./record-io.ts";
import type { RecordSummary } from "./record-io.ts";
import type { RecordIssue } from "./schema.ts";
import type { WorkRecord } from "./types.ts";

/** Where the CLI writes output. Tests pass a capture instead of the console. */
export interface CliIo {
  /** Normal output. */
  readonly out: (line: string) => void;
  /** Errors and usage. */
  readonly err: (line: string) => void;
}

interface CliOptions {
  readonly dir: string;
  readonly positional: readonly string[];
  readonly error: string | null;
}

const DEFAULT_DIR = "work/records";

const USAGE = [
  "usage: record <command> [args] [--dir work/records]",
  "",
  "  init NNNN     write a draft record",
  "  check [path]  validate a file or a directory",
  "  list          show every record and its done level",
  "  show NNNN     print one record",
].join("\n");

const parseArgs = (args: readonly string[]): CliOptions => {
  const positional: string[] = [];
  let dir = DEFAULT_DIR;
  let error: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dir") {
      const value = args[index + 1];
      if (value === undefined) {
        error = "record: --dir needs a value";
      } else {
        dir = value;
        index += 1;
      }
      continue;
    }
    if (arg !== undefined) positional.push(arg);
  }
  return { dir, positional, error };
};

const printIssues = (file: string, issues: readonly RecordIssue[], io: CliIo): void => {
  for (const issue of issues) {
    io.err(file + ": " + issue.path + ": " + issue.message);
  }
};

const draftRecord = (issue: string): WorkRecord => ({
  schema: 1,
  issue,
  intent: "",
  criteria: [{ id: "C1", kind: "manual", status: "unchecked" }],
  limits: [""],
  decision: { by: "", at: new Date().toISOString(), basis: "" },
  invalidation: [""],
});

const runInit = async (positional: readonly string[], dir: string, io: CliIo): Promise<number> => {
  const issue = positional[0];
  if (issue === undefined || !/^\d{4}$/u.test(issue)) {
    io.err("record init: issue must be four digits");
    return 2;
  }
  const file = join(dir, issue + ".yaml");
  if (existsSync(file)) {
    io.err("record init: already exists: " + file);
    return 1;
  }
  await writeRecordFile(file, draftRecord(issue));
  io.out(file);
  return 0;
};

const runCheck = async (
  positional: readonly string[],
  dir: string,
  cwd: string,
  io: CliIo,
): Promise<number> => {
  const targets = positional.length > 0 ? positional : [dir];
  let failures = 0;
  for (const target of targets) {
    const path = isAbsolute(target) ? target : resolve(cwd, target);
    let files: readonly string[];
    try {
      const info = await stat(path);
      files = info.isDirectory() ? await listRecordFiles(path) : [path];
    } catch (error) {
      io.err(path + ": " + (error instanceof Error ? error.message : "cannot read"));
      failures += 1;
      continue;
    }
    if (files.length === 0) {
      io.out(path + ": no records");
      continue;
    }
    for (const file of files) {
      const result = await readRecordFile(file);
      if (result.ok) {
        io.out(file + " " + result.level);
        continue;
      }
      failures += 1;
      if (result.kind === "read") {
        const first = result.issues[0];
        io.err(file + ": " + (first === undefined ? "cannot read" : first.message));
        continue;
      }
      io.err(file + ": invalid");
      printIssues(file, result.issues, io);
    }
  }
  return failures === 0 ? 0 : 1;
};

const runList = async (dir: string, io: CliIo): Promise<number> => {
  let summaries: readonly RecordSummary[];
  try {
    summaries = await readRecordDir(dir);
  } catch (error) {
    io.err(dir + ": " + (error instanceof Error ? error.message : "cannot read"));
    return 1;
  }
  io.out("issue  level        criteria  file");
  let invalid = 0;
  for (const summary of summaries) {
    if (summary.level === null) {
      invalid += 1;
      io.out(summary.issue.padEnd(7) + "invalid".padEnd(13) + "-".padEnd(10) + summary.file);
      continue;
    }
    const criteria = String(summary.passed) + "/" + String(summary.total);
    io.out(summary.issue.padEnd(7) + summary.level.padEnd(13) + criteria.padEnd(10) + summary.file);
  }
  if (summaries.length === 0) io.out("no records");
  return invalid === 0 ? 0 : 1;
};

const runShow = async (positional: readonly string[], dir: string, io: CliIo): Promise<number> => {
  const issue = positional[0];
  if (issue === undefined) {
    io.err("record show: issue is required");
    return 2;
  }
  const file = join(dir, issue + ".yaml");
  const result = await readRecordFile(file);
  if (!result.ok) {
    if (result.kind === "read") {
      const first = result.issues[0];
      io.err("record show: " + (first === undefined ? "cannot read" : first.message));
      return 1;
    }
    io.err(file + ": invalid");
    printIssues(file, result.issues, io);
    return 1;
  }
  io.out(formatRecord(result.record));
  io.out("");
  io.out("done level: " + result.level);
  return 0;
};

/**
 * Run one CLI command.
 *
 * @param argv - Arguments after the program name.
 * @param io - Output sinks.
 * @param cwd - Base for relative paths.
 * @returns Process exit code.
 */
export const runRecordCli = async (
  argv: readonly string[],
  io: CliIo,
  cwd: string,
): Promise<number> => {
  const command = argv[0];
  const options = parseArgs(argv.slice(1));
  const dir = isAbsolute(options.dir) ? options.dir : join(cwd, options.dir);
  if (options.error !== null) {
    io.err(options.error);
    io.err(USAGE);
    return 2;
  }
  if (command === undefined) {
    io.err(USAGE);
    return 2;
  }
  switch (command) {
    case "init":
      return await runInit(options.positional, dir, io);
    case "check":
      return await runCheck(options.positional, dir, cwd, io);
    case "list":
      return await runList(dir, io);
    case "show":
      return await runShow(options.positional, dir, io);
    default:
      io.err("record: unknown command: " + command);
      io.err(USAGE);
      return 2;
  }
};

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const code = await runRecordCli(
    process.argv.slice(2),
    {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    },
    process.cwd(),
  );
  process.exitCode = code;
}
