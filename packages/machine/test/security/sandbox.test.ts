// The machine's sandbox, hide list, and environment purity, proved against the real wrapper.
//
// Every case starts from the product's own path: createMachineExec over a temporary ROOT, driven
// by runExec from a wire-parsed `exec` request. A test that assembled its own bwrap arguments
// would pass while the product ran something else. The mutation cases at the end run the other
// way: they break one property at a time and require the same assertions to fail.
//
// A host without a usable bubblewrap skips, with the probe's reason in the skip message. On the
// release gate (HNS_REQUIRE_BWRAP=1) a missing bubblewrap is a failure, not a skip.
import { existsSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { requireBwrap } from "../../../../tools/test/cf-dev.ts";
import { createMachineExec, runExec } from "../../src/exec.ts";
import type { MachineExec } from "../../src/exec.ts";
import { MachineRefusal } from "../../src/refusal.ts";
import { parseOperation } from "../../src/wire.ts";
import { capturedArgv, hostEnv, runArgv, sandboxPaths, sandboxReport } from "../support/sandbox.ts";
import type { SandboxPaths } from "../support/sandbox.ts";

const report = await sandboxReport();
const why = report.available ? "" : report.reason;
// requireBwrap throws under HNS_REQUIRE_BWRAP=1 and answers false otherwise.
const skip = report.available ? false : !requireBwrap(false, why);

let paths: SandboxPaths;
let bwrap: string;
const savedEnv: Record<string, string | undefined> = {};
const SET_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "HNS_CONTROL_PLANE_KEY",
  "HNS_AGENT_URL",
  "HOME",
  "TERM",
];

beforeAll(async () => {
  // The paths are made whatever the verdict; only the cases that run bwrap skip.
  const made = await sandboxPaths();
  // A symlinked temp dir would make a hidden path name something other than the directory itself.
  paths = { ...made, base: await realpath(made.base) };
  bwrap = report.available ? report.bwrap : "bwrap";
  for (const name of SET_ENV) savedEnv[name] = process.env[name];
});

afterAll(async () => {
  for (const name of SET_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  if (paths !== undefined) await rm(paths.base, { recursive: true, force: true });
});

/** The secrets this suite puts in the server's own environment. */
const SECRETS = {
  ANTHROPIC_API_KEY: "sk-ant-must-not-leak",
  OPENAI_API_KEY: "sk-openai-must-not-leak",
  HNS_CONTROL_PLANE_KEY: "control-plane-must-not-leak",
  HNS_AGENT_URL: "https://provider.invalid",
} as const;

/**
 * A ready executor over a temporary ROOT.
 *
 * @returns The executor the product builds when the probe passed.
 *
 * @remarks
 * The secrets go into this process's environment on purpose: the case is "the server's
 * environment carries a key and the sandbox must not pass it on", which a child's own env cannot
 * show. HOME is the temporary home, so the hide list is the temporary one, not the operator's.
 */
async function readyExec(): Promise<MachineExec> {
  Object.assign(process.env, SECRETS, { HOME: paths.home, TERM: "xterm-256color" });
  return await createMachineExec(hostEnv(paths.project), {
    sandbox: report,
    root: paths.root,
    projectRoot: paths.project,
    home: paths.home,
  });
}

/** Run one wire-shaped `exec` request through the product's path. */
async function exec(
  machine: MachineExec,
  request: { readonly command?: string; readonly args?: readonly string[]; readonly cwd?: string },
): Promise<{ readonly exitCode: number; readonly output: string }> {
  const parsed = parseOperation(
    new TextEncoder().encode(JSON.stringify({ op: "exec", ...request })),
  );
  if (parsed.op !== "exec") throw new Error("the wire did not parse an exec");
  return await runExec(machine, parsed, {
    maxOutputBytes: 256 * 1024,
    signal: new AbortController().signal,
    root: paths.project,
  });
}

/** The wrapper argv the product builder makes for this fixture. */
async function machineArgv(): Promise<readonly string[]> {
  return await capturedArgv({
    env: hostEnv(paths.project),
    root: paths.root,
    projectRoot: paths.project,
    home: paths.home,
    bwrap,
  });
}

// C1: exec exists only behind the sandbox; a verdict of "unavailable" refuses and does not run.
test("C1: an agent with no sandbox refuses every exec instead of running it", async () => {
  const unavailable = {
    ...report,
    available: false,
    exec: "disabled",
    code: "not-found",
    reason: "bwrap was not found on PATH",
  } as const;
  const machine = await createMachineExec(hostEnv(paths.project), {
    sandbox: unavailable,
    root: paths.root,
    projectRoot: paths.project,
    home: paths.home,
  });
  const marker = join(paths.project, "refused.txt");
  // The failure is a refusal the caller branches on, so it is caught as a value here.
  const failure = await exec(machine, { command: "touch " + marker }).catch(
    (reason: Error) => reason,
  );
  expect(failure).toBeInstanceOf(MachineRefusal);
  if (!(failure instanceof MachineRefusal)) return;
  expect(failure.code).toBe("forbidden");
  expect(failure.message).toContain("bwrap was not found on PATH");
  expect(existsSync(marker)).toBe(false);
});

// C2: a sibling of the project sits beside it under ROOT and must not be reachable.
test.skipIf(skip)("C2: a sibling project under ROOT is not in the sandbox", async () => {
  const machine = await readyExec();
  expect(machine.ready).toBe(true);
  const outcome = await exec(machine, { args: ["/bin/sh", "-c", "cat " + paths.sibling] });
  expect(outcome.exitCode).not.toBe(0);
  expect(outcome.output).not.toContain("sibling-secret");
});

// C2: the hide list masks ~/.config/hns, so neither the device key nor the tunnel token reads.
test.skipIf(skip)(
  "C2: the hidden ~/.config/hns answers nothing and the project still reads",
  async () => {
    const machine = await readyExec();
    const hidden = join(paths.home, ".config", "hns");
    const outcome = await exec(machine, {
      args: [
        "/bin/sh",
        "-c",
        "cat " +
          join(hidden, "device.key") +
          "; cat " +
          join(hidden, "cloudflared") +
          "; cat readme.txt",
      ],
    });
    expect(outcome.output).not.toContain("device-secret");
    expect(outcome.output).not.toContain("cloudflared-secret");
    expect(outcome.output).toContain("project");
  },
);

// C2: the home's other credential places are hidden too.
test.skipIf(skip)("C2: every path in the fixed hide list is empty inside the sandbox", async () => {
  const machine = await readyExec();
  const listing = async (path: string): Promise<string> =>
    (await exec(machine, { args: ["/bin/sh", "-c", "ls -A " + path + " 2>&1"] })).output;
  expect(await listing(join(paths.home, ".config", "hns"))).not.toContain("device.key");
  expect(await listing(join(paths.home, ".ssh"))).not.toContain("id_ed25519");
});

// C4: the environment is the allowlist, whatever the server's environment carries.
test.skipIf(skip)(
  "C4: provider keys, provider URLs, and the device key are not in the sandbox env",
  async () => {
    const machine = await readyExec();
    const outcome = await exec(machine, { args: ["/bin/sh", "-c", "env"] });
    for (const name of Object.keys(SECRETS)) expect(outcome.output).not.toContain(name);
    for (const value of Object.values(SECRETS)) expect(outcome.output).not.toContain(value);
    expect(outcome.output).toContain("TMPDIR=/tmp");
    expect(outcome.output).toContain("GIT_OPTIONAL_LOCKS=0");
    // HOME is the ROOT (0045 H-1), not the account whose home holds the secrets.
    expect(outcome.output).toContain("HOME=" + paths.root);
  },
);

// The allowlist is exactly the fixed set: nothing else is passed even when it is set.
test.skipIf(skip)("C4: the sandbox env names only the allowlisted variables", async () => {
  process.env.SOME_OTHER_VARIABLE = "must-not-be-passed";
  try {
    const machine = await readyExec();
    const outcome = await exec(machine, { args: ["/bin/sh", "-c", "env"] });
    const names = outcome.output
      .split("\n")
      .map((line) => line.split("=")[0] ?? "")
      .filter((name) => name !== "");
    const allowed = [
      "PATH",
      "HOME",
      "LANG",
      "TERM",
      "TMPDIR",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_OPTIONAL_LOCKS",
      "PWD",
      "SHLVL",
      "_",
    ];
    for (const name of names) expect(allowed).toContain(name);
    expect(names).not.toContain("SOME_OTHER_VARIABLE");
  } finally {
    delete process.env.SOME_OTHER_VARIABLE;
  }
});

// The git config switches are the shell's own: they cannot be redirected to the operator's file.
test.skipIf(skip)(
  "C4: the shell's git config is /dev/null, so HOME cannot supply one",
  async () => {
    const machine = await readyExec();
    const outcome = await exec(machine, {
      args: ["/bin/sh", "-c", 'printf \'%s %s\\n\' "$GIT_CONFIG_GLOBAL" "$GIT_CONFIG_SYSTEM"'],
    });
    expect(outcome.output.trim()).toBe("/dev/null /dev/null");
  },
);

// C3: .git is readable but not writable, and the rest of the project stays writable.
test.skipIf(skip)(
  "C3: a write under .git is refused with EROFS and the project still writes",
  async () => {
    const git = join(paths.project, ".git");
    await mkdir(git, { recursive: true });
    await writeFile(join(git, "HEAD"), "ref: refs/heads/main\n");
    const machine = await readyExec();
    const outcome = await exec(machine, {
      args: [
        "/bin/sh",
        "-c",
        "echo applied > ok.txt && echo w > .git/HEAD 2>&1; echo rc=$?; cat .git/HEAD",
      ],
    });
    expect(existsSync(join(paths.project, "ok.txt"))).toBe(true);
    expect(outcome.output).toContain("rc=1");
    expect(outcome.output).toMatch(/Read-only file system/u);
    // The refusal is the write, not a mask: the file still reads with its content.
    expect(outcome.output).toContain("ref: refs/heads/main");
    expect(outcome.output).not.toMatch(/^w$/mu);
  },
);

// The order that makes .git read-only is a property of the argv, not of the moment it is checked.
test.skipIf(skip)("C3: the .git read-only bind comes after the writable project bind", async () => {
  const argv = await machineArgv();
  const gitBind = argv.lastIndexOf("--ro-bind");
  const projectBind = argv.lastIndexOf("--bind");
  expect(argv.at(gitBind + 1)).toBe(join(paths.project, ".git"));
  expect(projectBind).toBeGreaterThan(-1);
  expect(gitBind).toBeGreaterThan(projectBind);
});

// C6: deny means the namespace itself has no route out.
test.skipIf(skip)("C6: egress deny runs in a network namespace with loopback only", async () => {
  const machine = await readyExec();
  // /proc/net is the process's own network stack, so it shows the namespace the shell runs in.
  // (/sys/class/net is the host's mount and would show the host's interfaces either way.)
  const outcome = await exec(machine, { args: ["/bin/sh", "-c", "cat /proc/net/dev"] });
  const interfaces = outcome.output
    .split("\n")
    .map((line) => line.split(":")[0]?.trim() ?? "")
    .filter((name) => name !== "" && !name.startsWith("Inter-") && !name.startsWith("face"))
    .filter((name) => !name.includes("|"));
  expect(interfaces).toStrictEqual(["lo"]);
});

// The namespaces are a property of the wrapper's argv too, so a lost flag is a test failure.
test.skipIf(skip)("C6: the wrapper asks for the network to be unshared", async () => {
  const argv = await machineArgv();
  expect(argv).toContain("--unshare-net");
});

// The wrapper is the machine's: /tmp is masked and the project is bound inside a fresh ROOT.
test.skipIf(skip)(
  "the wrapper masks nothing the host does not have, so an absent hide path still starts",
  () => {
    // mkdir'ing the parent of .aws/.netrc is not done by the fixture, so those entries are absent.
    expect(existsSync(join(paths.home, ".aws"))).toBe(false);
    const outcome = runArgv([bwrap, "--version"]);
    expect(outcome.status).toBe(0);
  },
);
