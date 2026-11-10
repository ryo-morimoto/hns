import { expect, afterAll, test } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { LocalExecutionEnv, Connection, localDaemon } from "@earendil-works/pi-env";
import {
  createNoExecEnv,
  createSandboxEnv,
  detectSandbox,
  parseVersion,
  resolveShell,
} from "../../src/sandbox.ts";
import type { SandboxReport } from "../../src/sandbox.ts";

const base = await mkdtemp(join(tmpdir(), "hns-sandbox-"));

/** Run one shell command and return what it printed. */
async function outputOf(env: ExecutionEnv, script: string): Promise<string> {
  let output = "";
  getOrThrow(
    await env.exec(
      [resolveShell(), "-c", script],
      {
        onOutput: (text) => {
          output += text;
        },
      },
      ctx,
    ),
  );
  return output;
}
const BWRAP = process.env.BWRAP ?? "bwrap";

let detectedPromise: Promise<SandboxReport> | undefined;
/** The host verdict, computed once: the probe runs bubblewrap. */
function detected(): Promise<SandboxReport> {
  detectedPromise ??= detectSandbox(BWRAP);
  return detectedPromise;
}

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

test("the version of bubblewrap is parsed", () => {
  expect(parseVersion("bubblewrap 0.12.0")).toStrictEqual([0, 12, 0]);
  expect(parseVersion("0.12.0")).toStrictEqual([0, 12, 0]);
  expect(parseVersion("not a version")).toBe(undefined);
});

// Catches: detection used /bin/true, which NixOS lacks, so a working bwrap was reported unavailable.
test("detection reports a verdict that names the deciding check", async () => {
  const status = await detected();

  if (status.available) {
    expect(status.exec).toBe("enabled");
    expect(status.userNamespaces).toBe("ok");
    expect(status.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(status.bwrap.startsWith("/")).toBe(true);
    return;
  }
  expect(status.exec).toBe("disabled");
  expect(status.code.length).toBeGreaterThan(0);
  expect(status.reason.length).toBeGreaterThan(0);
});

test("a missing bwrap is a verdict, not an exception", async () => {
  const missing = await detectSandbox(join(base, "no-bwrap"));

  expect.assert(!missing.available);
  expect(missing.code).toBe("not-found");
  expect(missing.exec).toBe("disabled");
});

test("a program that is not executable is rejected", async () => {
  const blocked = join(base, "not-executable");
  await writeFile(blocked, "#!/bin/sh\nexit 0\n", { mode: 0o644 });

  const status = await detectSandbox(blocked);

  expect.assert(!status.available);
  expect(status.code).toBe("not-executable");
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

  expect.assert(!status.available);
  expect(status.code).toBe("userns-unavailable");
  expect(status.userNamespaces).toBe("blocked");
});

test("a root of / is refused", () => {
  const env = new NodeExecutionEnv({ cwd: base });

  expect(() => createSandboxEnv(env, { root: "/" })).toThrow(Error);
  expect(() => createSandboxEnv(env, { root: "root" })).toThrow(Error);
});

test("exec is refused when the sandbox is unavailable", async () => {
  const connection = new Connection({ command: [localDaemon()] });
  const env = new LocalExecutionEnv({ cwd: base, connection });
  const root = join(base, "root-refused");
  await env.createDir(root, undefined, ctx);
  const missing = await detectSandbox(join(base, "no-bwrap"));
  expect.assert(!missing.available);
  const disabled = createNoExecEnv(env, missing);

  const refused = await disabled.exec("echo should-not-run > refused.txt", undefined, ctx);
  expect(refused.ok).toBe(false);
  if (refused.ok) return;
  expect(refused.error.code).toBe("shell_unavailable");
  expect((await readdir(base)).includes("refused.txt")).toBe(false);
  expect(getOrThrow(await disabled.exists(root, ctx))).toBe(true);
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
  expect(inside.exitCode).toBe(0);
  expect((await readdir(root)).includes("b.txt")).toBe(true);

  getOrThrow(await sandbox.exec("echo escape > ../" + escapeName + ".txt", undefined, ctx));
  expect((await readdir(base)).includes(escapeName + ".txt")).toBe(false);

  getOrThrow(await sandbox.exec("echo home > $HOME/" + escapeName + ".txt", undefined, ctx));
  expect((await readdir(homedir())).includes(escapeName + ".txt")).toBe(false);

  const read = getOrThrow(await sandbox.exec("head -c 40 /etc/hostname", undefined, ctx));
  expect(read.exitCode).toBe(0);

  const exited = getOrThrow(await sandbox.exec("exit 7", undefined, ctx));
  expect(exited.exitCode).toBe(7);

  const argv = getOrThrow(
    await sandbox.exec([resolveShell(), "-c", "echo argv > c.txt"], undefined, ctx),
  );
  expect(argv.exitCode).toBe(0);
  expect((await readdir(root)).includes("c.txt")).toBe(true);

  await sandbox.createDir(join(root, "sub"), undefined, ctx);
  expect(getOrThrow(await sandbox.exists(join(root, "sub"), ctx))).toBe(true);
  await env.cleanup(ctx);
  await connection.close();
});
// Catches: bash inherited the server's environment, so API keys were visible to the agent.
test("the sandbox clears the server environment and points HOME at the root", async (t) => {
  const status = await detected();
  if (!status.available) {
    t.skip("bubblewrap is unavailable: " + status.reason);
    return;
  }
  const root = join(base, "root-env");
  const env = new NodeExecutionEnv({ cwd: base });
  await env.createDir(root, undefined, ctx);
  process.env.HNS_TEST_SECRET = "leaked";
  const sandbox = createSandboxEnv(env, { root, bwrap: status.bwrap, shell: status.shell });
  try {
    const secret = await outputOf(sandbox, 'printf %s "$HNS_TEST_SECRET"');
    expect(secret).toBe("");
    const home = await outputOf(sandbox, 'printf %s "$HOME"');
    expect(home).toBe(root);
  } finally {
    delete process.env.HNS_TEST_SECRET;
    await env.cleanup(ctx);
  }
});

// Catches: the read-only root bind exposed the key files to the agent's shell.
test("a hidden directory is masked inside the sandbox", async (t) => {
  const status = await detected();
  if (!status.available) {
    t.skip("bubblewrap is unavailable: " + status.reason);
    return;
  }
  const root = join(base, "root-hide");
  const secrets = join(base, "secrets");
  const env = new NodeExecutionEnv({ cwd: base });
  await env.createDir(root, undefined, ctx);
  await env.createDir(secrets, undefined, ctx);
  await env.writeFile(join(secrets, "key.txt"), "secret", ctx);
  const sandbox = createSandboxEnv(env, {
    root,
    bwrap: status.bwrap,
    shell: status.shell,
    hide: [secrets],
  });
  try {
    const listed = await outputOf(sandbox, "ls -A " + secrets);
    expect(listed.trim()).toBe("");
  } finally {
    await env.cleanup(ctx);
  }
});
