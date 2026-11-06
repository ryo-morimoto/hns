// Consistent backup and restore of a state directory (SQLite snapshots + files).
import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATABASES = ["session.sqlite", "control.sqlite"];
const FILES = ["journal.json", "token"];

function quote(text) { return "'" + text.replaceAll("'", "''") + "'"; }

export async function backupState(stateDir, outDir) {
  await mkdir(outDir, { recursive: true });
  for (const name of DATABASES) {
    const source = join(stateDir, name);
    if (!existsSync(source)) continue;
    const db = new DatabaseSync(source);
    try { db.exec("VACUUM INTO " + quote(join(outDir, name))); }
    finally { db.close(); }
  }
  for (const name of FILES) {
    const source = join(stateDir, name);
    if (existsSync(source)) await copyFile(source, join(outDir, name));
  }
  return outDir;
}

/** Restore into a state directory; stop the app first. */
export async function restoreState(backupDir, stateDir) {
  await mkdir(stateDir, { recursive: true });
  for (const name of [...DATABASES, ...FILES]) {
    const source = join(backupDir, name);
    const target = join(stateDir, name);
    if (!existsSync(source)) continue;
    for (const suffix of ["-wal", "-shm"]) await rm(target + suffix, { force: true });
    await copyFile(source, target);
  }
  return stateDir;
}

if (import.meta.url === "file://" + process.argv[1]) {
  const [command, from, to] = process.argv.slice(2);
  if (command === "--restore") {
    await restoreState(from, to);
    console.log("restored", from, "->", to);
  } else {
    await backupState(command, from);
    console.log("backed up", command, "->", from);
  }
}
