import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { baseRecord } from "../test/support/records.ts";
import { runRecordCli } from "./cli.ts";
import { writeRecordFile } from "./record-io.ts";

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
    },
    out,
    err,
  };
};

test("init writes a draft that check rejects", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hns-record-cli-"));
  const captureOne = capture();
  expect(await runRecordCli(["init", "0200"], captureOne.io, cwd)).toBe(0);
  expect(existsSync(join(cwd, "work/records/0200.yaml"))).toBe(true);
  const captureTwo = capture();
  expect(await runRecordCli(["check"], captureTwo.io, cwd)).toBe(1);
  expect(captureTwo.err.join("\n")).toContain("must not be empty");
});

test("check, list, and show accept a complete record", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hns-record-cli-"));
  const file = join(cwd, "work/records/0200.yaml");
  await writeRecordFile(file, baseRecord());
  const check = capture();
  expect(await runRecordCli(["check"], check.io, cwd)).toBe(0);
  expect(check.out.join("\n")).toContain("0200.yaml verified");
  const list = capture();
  expect(await runRecordCli(["list"], list.io, cwd)).toBe(0);
  expect(list.out.join("\n")).toContain("verified");
  const show = capture();
  expect(await runRecordCli(["show", "0200"], show.io, cwd)).toBe(0);
  expect(show.out.join("\n")).toContain("done level: verified");
});

test("--dir without a value exits 2", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hns-record-cli-"));
  const captureOne = capture();
  expect(await runRecordCli(["check", "--dir"], captureOne.io, cwd)).toBe(2);
  expect(captureOne.err.join("\n")).toContain("--dir needs a value");
});

test("a missing directory is one line, not a stack", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hns-record-cli-"));
  const captureOne = capture();
  expect(await runRecordCli(["list", "--dir", "nope"], captureOne.io, cwd)).toBe(1);
  expect(captureOne.err.join("\n")).toContain("nope");
  expect(captureOne.err.join("\n")).not.toContain("    at ");
});

test("an unknown command exits 2", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hns-record-cli-"));
  const captureOne = capture();
  expect(await runRecordCli(["nope"], captureOne.io, cwd)).toBe(2);
});
