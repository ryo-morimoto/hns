// exec inside bubblewrap: only the root is writable, the rest of the host read-only.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutionEnv, Connection, localDaemon } from "@earendil-works/pi-env";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createSandboxEnv } from "../workspace-core/sandbox.mjs";

const BWRAP = process.env.BWRAP ?? "/nix/store/mvj6y8k3xs35cj7kq937xi44q4hl3r93-bubblewrap-0.12.0/bin/bwrap";
let pass = 0, fail = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };

const base = await mkdtemp(join(tmpdir(), "hns-sandbox-"));
const root = join(base, "root");
const connection = new Connection({ command: [localDaemon()] });
const env = new LocalExecutionEnv({ cwd: base, connection });
await env.createDir(root, undefined, ctx);
const sandbox = createSandboxEnv(env, { root, bwrap: BWRAP });

// writes inside the root work
getOrThrow(await sandbox.exec("echo inside > b.txt", undefined, ctx));
check((await readdir(root)).includes("b.txt"), "write inside root");

// writes outside the root fail; the host file is not created
getOrThrow(await sandbox.exec("echo escape > ../escape.txt", undefined, ctx));
check(!(await readdir(base)).includes("escape.txt"), "parent write blocked");

getOrThrow(await sandbox.exec("echo home > $HOME/escape.txt", undefined, ctx));
check(!(await readdir("/home/ryo-morimoto")).includes("escape.txt"), "home write blocked");

// reading the host still works
const read = getOrThrow(await sandbox.exec("head -c 40 /etc/hostname", undefined, ctx));
check(read.exitCode === 0, "read host file");

// exit code and argv form survive the wrapper
const exited = getOrThrow(await sandbox.exec("exit 7", undefined, ctx));
check(exited.exitCode === 7, "exit code preserved", String(exited.exitCode));
getOrThrow(await sandbox.exec(["/bin/sh", "-c", "echo argv > c.txt"], undefined, ctx));
check((await readdir(root)).includes("c.txt"), "argv command works");

// the workspace API is unaffected
await sandbox.createDir(join(root, "sub"), undefined, ctx);
check(getOrThrow(await sandbox.exists(join(root, "sub"), ctx)), "file API delegates");

await env.cleanup?.(ctx);
await connection.close();
await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
