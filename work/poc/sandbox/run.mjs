// Sandbox: bubblewrap detection, refusal when unavailable, and exec containment.
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutionEnv, Connection, localDaemon } from "@earendil-works/pi-env";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import {
  createNoExecEnv,
  createSandboxEnv,
  detectSandbox,
  resolveShell,
  SandboxUnavailableError,
} from "../workspace-core/sandbox.mjs";

const BWRAP = process.env.BWRAP || "bwrap";
let pass = 0, fail = 0, skipped = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };
const skip = (name, why) => { skipped++; console.log("SKIP", name, why ?? ""); };

const base = await mkdtemp(join(tmpdir(), "hns-sandbox-"));

// Catches: detection used /bin/true, which NixOS lacks, so a working bwrap was reported unavailable.
const detected = await detectSandbox(BWRAP);
if (detected.available) {
  check(/^\d+\.\d+\.\d+$/.test(String(detected.version)), "detection reports the bwrap version", JSON.stringify(detected));
  check(detected.userNamespaces === "ok" && detected.exec === "enabled", "detection enables exec after the user-namespace probe", JSON.stringify(detected));
  check(typeof detected.bwrap === "string" && detected.bwrap.startsWith("/"), "detection resolves bwrap to a path", JSON.stringify(detected));
} else {
  check(detected.exec === "disabled" && Boolean(detected.code) && Boolean(detected.reason), "detection disables exec with a reason", JSON.stringify(detected));
}

// A missing or unusable bwrap is a verdict, not an exception.
const missing = await detectSandbox(join(base, "no-bwrap"));
check(missing.available === false && missing.code === "not-found" && missing.exec === "disabled", "a missing bwrap is reported", JSON.stringify(missing));

const notExecutable = join(base, "not-executable");
await writeFile(notExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
const blockedFile = await detectSandbox(notExecutable);
check(blockedFile.available === false && blockedFile.code === "not-executable", "a non-executable bwrap is rejected", JSON.stringify(blockedFile));

// A stub that fails the way a host without unprivileged user namespaces does.
const blocked = join(base, "blocked-bwrap");
await writeFile(blocked, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'bubblewrap 0.12.0'; else echo 'bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.' >&2; exit 1; fi\n", { mode: 0o755 });
const userns = await detectSandbox(blocked);
check(userns.available === false && userns.code === "userns-unavailable" && userns.userNamespaces === "blocked", "a host without user namespaces is named", JSON.stringify(userns));

const shellPath = resolveShell();
if (shellPath.startsWith("/")) {
  const impostor = await detectSandbox(shellPath);
  check(impostor.available === false && impostor.code !== "not-found", "a program that is not bwrap fails the probe", JSON.stringify(impostor));
} else {
  skip("impostor probe", "no absolute shell on this host");
}

const root = join(base, "root");
const connection = new Connection({ command: [localDaemon()] });
const env = new LocalExecutionEnv({ cwd: base, connection });
await env.createDir(root, undefined, ctx);

// Without a verdict, exec fails closed instead of running on the host.
const disabled = createNoExecEnv(env, missing);
let refused;
try { await disabled.exec("echo should-not-run > refused.txt", undefined, ctx); } catch (error) { refused = error; }
check(refused instanceof SandboxUnavailableError && String(refused.message).includes("not found"), "exec is refused when the sandbox is unavailable", String(refused));
check(!(await readdir(base)).includes("refused.txt"), "a refused exec ran nothing");
check(getOrThrow(await disabled.exists(root, ctx)), "the file API still delegates without exec");

let rootRejected;
try { createSandboxEnv(env, { root: "/" }); } catch (error) { rootRejected = error; }
check(rootRejected instanceof Error, "a root of / is refused", String(rootRejected));

if (!detected.available) {
  skip("containment", detected.reason);
} else {
  const sandbox = createSandboxEnv(env, { root, bwrap: detected.bwrap });

  // writes inside the root work
  getOrThrow(await sandbox.exec("echo inside > b.txt", undefined, ctx));
  check((await readdir(root)).includes("b.txt"), "write inside root");

  // writes outside the root fail; the host file is not created
  getOrThrow(await sandbox.exec("echo escape > ../escape.txt", undefined, ctx));
  check(!(await readdir(base)).includes("escape.txt"), "parent write blocked");

  getOrThrow(await sandbox.exec("echo home > $HOME/escape.txt", undefined, ctx));
  check(!(await readdir(homedir())).includes("escape.txt"), "home write blocked");

  // reading the host still works
  const read = getOrThrow(await sandbox.exec("head -c 40 /etc/hostname", undefined, ctx));
  check(read.exitCode === 0, "read host file");

  // exit code and argv form survive the wrapper
  const exited = getOrThrow(await sandbox.exec("exit 7", undefined, ctx));
  check(exited.exitCode === 7, "exit code preserved", String(exited.exitCode));
  getOrThrow(await sandbox.exec([shellPath, "-c", "echo argv > c.txt"], undefined, ctx));
  check((await readdir(root)).includes("c.txt"), "argv command works");

  // the workspace API is unaffected
  await sandbox.createDir(join(root, "sub"), undefined, ctx);
  check(getOrThrow(await sandbox.exists(join(root, "sub"), ctx)), "file API delegates");
}

await env.cleanup?.(ctx);
await connection.close();
await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed${skipped ? `, ${skipped} skipped` : ""}`);
process.exitCode = fail ? 1 : 0;
