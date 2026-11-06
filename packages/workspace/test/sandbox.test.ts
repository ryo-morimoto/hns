import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { LocalExecutionEnv, Connection, localDaemon } from "@earendil-works/pi-env";
import {
  createNoExecEnv,
  createSandboxEnv,
  detectSandbox,
  parseVersion,
  resolveShell,
  SandboxUnavailableError,
} from "../src/sandbox.ts";
import type { SandboxReport } from "../src/sandbox.ts";

const base = await mkdtemp(join(tmpdir(), "hns-sandbox-"));
const BWRAP = process.env.BWRAP ?? "bwrap";

let detectedPromise: Promise<SandboxReport> | undefined;
/** The host verdict, computed once: the probe runs bubblewrap. */
function detected(): Promise<SandboxReport> {
  detectedPromise ??= detectSandbox(BWRAP);
  return detectedPromise;
}

after(async () => {
  await rm(base, { recursive: true, force: true });
});

test("the version of bubblewrap is parsed", () => {
  assert.deepEqual(parseVersion("bubblewrap 0.12.0"), [0, 12, 0]);
  assert.deepEqual(parseVersion("0.12.0"), [0, 12, 0]);
  assert.equal(parseVersion("not a version"), undefined);
});

// Catches: detection used /bin/true, which NixOS lacks, so a working bwrap was reported unavailable.
test("detection reports a verdict that names the deciding check", async () => {
  const status = await detected();

  if (status.available) {
    assert.equal(status.exec, "enabled");
    assert.equal(status.userNamespaces, "ok");
    assert.match(status.version, /^\d+\.\d+\.\d+$/);
    assert.ok(status.bwrap.startsWith("/"));
    return;
  }
  assert.equal(status.exec, "disabled");
  assert.ok(status.code.length > 0);
  assert.ok(status.reason.length > 0);
});

test("a missing bwrap is a verdict, not an exception", async () => {
  const missing = await detectSandbox(join(base, "no-bwrap"));

  assert.equal(missing.available, false);
  assert.equal(missing.code, "not-found");
  assert.equal(missing.exec, "disabled");
});

test("a program that is not executable is rejected", async () => {
  const blocked = join(base, "not-executable");
  await writeFile(blocked, "#!/bin/sh\nexit 0\n", { mode: 0o644 });

  const status = await detectSandbox(blocked);

  assert.equal(status.available, false);
  assert.equal(status.code, "not-executable");
});

// Catches: a version check alone passed on a host without user namespaces.
test("a host without user namespaces is named", async () => {
  const blocked = join(base, "blocked-bwrap");
  await writeFile(
    blocked,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo \'bubblewrap 0.12.0\'; ' +
      "else echo 'bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.' >&2; exit 1; fi\n",
    { mode: 0o755 },
  );

  const status = await detectSandbox(blocked);

  assert.equal(status.available, false);
  assert.equal(status.code, "userns-unavailable");
  assert.equal(status.userNamespaces, "blocked");
});

test("a root of / is refused", () => {
  const env = new NodeExecutionEnv({ cwd: base });

  assert.throws(() => createSandboxEnv(env, { root: "/" }), Error);
  assert.throws(() => createSandboxEnv(env, { root: "root" }), Error);
});

test("exec is refused when the sandbox is unavailable", async () => {
  const connection = new Connection({ command: [localDaemon()] });
  const env = new LocalExecutionEnv({ cwd: base, connection });
  const root = join(base, "root-refused");
  await env.createDir(root, undefined, ctx);
  const missing = await detectSandbox(join(base, "no-bwrap"));
  assert.ok(!missing.available);
  const disabled = createNoExecEnv(env, missing);

  await assert.rejects(
    disabled.exec("echo should-not-run > refused.txt", undefined, ctx),
    SandboxUnavailableError,
  );
  assert.equal((await readdir(base)).includes("refused.txt"), false);
  assert.equal(getOrThrow(await disabled.exists(root, ctx)), true);
  await connection.close();
});

test("exec runs inside the root and cannot write outside", async (t) => {
  const status = await detected();
  if (!status.available) {
    t.skip("bubblewrap is unavailable: " + status.reason);
    return;
  }
  const connection = new Connection({ command: [localDaemon()] });
  const env = new LocalExecutionEnv({ cwd: base, connection });
  const root = join(base, "root-sandbox");
  await env.createDir(root, undefined, ctx);
  const sandbox = createSandboxEnv(env, { root, bwrap: status.bwrap });
  const escapeName = "hns-escape-" + String(process.pid);

  const inside = getOrThrow(await sandbox.exec("echo inside > b.txt", undefined, ctx));
  assert.equal(inside.exitCode, 0);
  assert.equal((await readdir(root)).includes("b.txt"), true);

  getOrThrow(await sandbox.exec("echo escape > ../" + escapeName + ".txt", undefined, ctx));
  assert.equal((await readdir(base)).includes(escapeName + ".txt"), false);

  getOrThrow(await sandbox.exec("echo home > $HOME/" + escapeName + ".txt", undefined, ctx));
  assert.equal((await readdir(homedir())).includes(escapeName + ".txt"), false);

  const read = getOrThrow(await sandbox.exec("head -c 40 /etc/hostname", undefined, ctx));
  assert.equal(read.exitCode, 0);

  const exited = getOrThrow(await sandbox.exec("exit 7", undefined, ctx));
  assert.equal(exited.exitCode, 7);

  const argv = getOrThrow(
    await sandbox.exec([resolveShell(), "-c", "echo argv > c.txt"], undefined, ctx),
  );
  assert.equal(argv.exitCode, 0);
  assert.equal((await readdir(root)).includes("c.txt"), true);

  await sandbox.createDir(join(root, "sub"), undefined, ctx);
  assert.equal(getOrThrow(await sandbox.exists(join(root, "sub"), ctx)), true);
  await env.cleanup(ctx);
  await connection.close();
});
