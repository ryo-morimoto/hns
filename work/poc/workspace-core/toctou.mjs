// 0005: the check and the use are one resolution. Swapping a parent directory
// while a write or a read is in flight must not move it outside the root.
import { mkdir, mkdtemp, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionError } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { LocalExecutionEnv, Connection, localDaemon } from "@earendil-works/pi-env";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Workspace } from "./workspace.mjs";

let pass = 0, fail = 0;
const check = (ok, name, detail) => {
  if (ok) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, detail ?? ""); }
};

/** Run \`attack\` once, right after the environment resolved \`watched\`. */
function attackAfter(env, watched, attack) {
  let fired = false;
  const wrapper = new Proxy(env, {
    get(target, property) {
      if (property === "canonicalPath") {
        return async (path, context) => {
          const result = await target.canonicalPath(path, context);
          if (!fired && path === watched) { fired = true; await attack(); }
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { env: wrapper, fired: () => fired };
}

/** An environment whose exec is unavailable, as on a host without the helper. */
function withoutExec(env) {
  return new Proxy(env, {
    get(target, property) {
      if (property === "exec") return async () => ({ ok: false, error: new ExecutionError("spawn_error", "no exec") });
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const swapParent = async (root, name, outside) => {
  await rename(join(root, name), join(root, name + "-old"));
  await symlink(outside, join(root, name));
};
const restoreParent = async (root, name) => {
  await unlink(join(root, name));
  await rename(join(root, name + "-old"), join(root, name));
};

/** Flip \`root/name\` between a directory and a link to \`outside\` until stopped. */
async function churn(root, name, outside, state) {
  while (!state.stop) {
    await rename(join(root, name), join(root, name + "-old")).catch(() => {});
    await symlink(outside, join(root, name)).catch(() => {});
    await unlink(join(root, name)).catch(() => {});
    await rename(join(root, name + "-old"), join(root, name)).catch(() => {});
  }
}

async function makeTarget(kind) {
  const base = await mkdtemp(join(tmpdir(), "hns-toctou-"));
  let env, close = async () => {};
  if (kind === "node") {
    env = new NodeExecutionEnv({ cwd: base });
  } else {
    const connection = new Connection({ command: [localDaemon()] });
    env = new LocalExecutionEnv({ cwd: base, connection });
    close = () => connection.close();
  }
  const open = async (name, options = {}) => {
    const root = join(base, "root-" + name);
    await env.createDir(root, { recursive: true }, ctx);
    const ws = await new Workspace({
      env: options.env ?? env, root, journalPath: join(base, "journal-" + name + ".json"), context: ctx,
      rooted: options.rooted,
    }).open();
    return { ws, root };
  };
  return { base, env, open, close };
}

async function scenario(kind) {
  const t = await makeTarget(kind);

  // The boundary the fix has to hold: swapping a parent must never redirect a write.
  {
    const { ws, root } = await t.open("mode");
    check(ws.mode === "dirfd", `${kind} rooted mode available`, ws.mode);
  }

  /** A root with d/f.txt already written, so the next write replaces it. */
  const seeded = async (name, rooted) => {
    const outside = join(t.base, "outside-" + name);
    const { ws, root } = await t.open(name, { rooted });
    await mkdir(join(root, "d"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await ws.write({ path: "d/f.txt", content: "inside", expectedVersion: "absent", operationId: "seed" });
    const version = (await ws.read("d/f.txt")).version;
    return { root, outside, version };
  };
  const replace = async (name, root, outside, version, extra) => {
    const replacement = await new Workspace({
      env: extra.env ?? t.env, root, journalPath: join(t.base, "journal-" + name + "-2.json"), context: ctx,
      rooted: extra.rooted, beforeRename: extra.beforeRename,
    }).open();
    const result = await replacement.write({ path: "d/f.txt", content: "x", expectedVersion: version, operationId: "w-" + name });
    return { result, workspace: replacement };
  };

  // Catches: the window between the parent re-check and rename(2) — the path-based
  // fallback still loses it, which is what the dirfd path closes.
  {
    const { root, outside, version } = await seeded("fallback-write", false);
    const trap = attackAfter(t.env, join(root, "d"), () => swapParent(root, "d", outside));
    const { result, workspace } = await replace("fallback-write", root, outside, version, { env: trap.env, rooted: false });
    check((await readdir(outside)).includes("f.txt"), `${kind} checks-only write escapes (control)`);
    check(result.status === "unknown", `${kind} checks-only write reports unknown`, JSON.stringify(result));
    check(workspace.auditLog.some((entry) => entry.reason === "escaped after rename"), `${kind} checks-only write is audited`);
    await workspace.close();
  }

  // Catches: a parent swapped after the last check must not take the write with it.
  {
    const { root, outside, version } = await seeded("dirfd-write", true);
    const { result, workspace } = await replace("dirfd-write", root, outside, version, {
      rooted: true,
      // Runs after the temp file is written: as late as a real attacker can act.
      beforeRename: () => swapParent(root, "d", outside),
    });
    check(!(await readdir(outside)).includes("f.txt"), `${kind} dirfd write stays inside`);
    check(result.status === "unknown", `${kind} dirfd write reports unknown`, JSON.stringify(result));
    await workspace.close();
  }

  // Catches: repeated writes while the parent is swapped must not leak, ever.
  {
    const outside = join(t.base, "outside-churn");
    const { ws, root } = await t.open("churn", { rooted: true });
    await mkdir(join(root, "d"), { recursive: true });
    await mkdir(outside, { recursive: true });
    const state = { stop: false };
    const toggling = churn(root, "d", outside, state);
    const outcomes = [];
    let leaked = false;
    for (let i = 0; i < 30; i += 1) {
      const result = await ws.write({ path: "d/f" + i + ".txt", content: "v" + i, expectedVersion: "absent", operationId: "churn-" + i })
        .then((value) => value.status, (error) => "error:" + (error?.message ?? error));
      outcomes.push(result);
      if ((await readdir(outside)).length > 0) leaked = true;
    }
    state.stop = true;
    await toggling;
    check(!leaked, `${kind} churn never writes outside`, JSON.stringify(await readdir(outside)));
    check(outcomes.includes("applied"), `${kind} churn still applies writes`, JSON.stringify(outcomes));
    await ws.close();
  }

  // Catches: a parent swapped after the resolve must not be followed by a read.
  {
    const readWith = async (name, rooted) => {
      const outside = join(t.base, "outside-" + name);
      const { ws, root } = await t.open(name, { rooted });
      await mkdir(join(root, "d"), { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(root, "d/f.txt"), "inside");
      await writeFile(join(outside, "f.txt"), "SECRET");
      const trap = attackAfter(t.env, join(root, "d/f.txt"), () => swapParent(root, "d", outside));
      const reader = await new Workspace({
        env: trap.env, root, journalPath: join(t.base, "journal-" + name + "-2.json"), context: ctx, rooted,
      }).open();
      const outcome = await reader.read("d/f.txt").then((value) => value.content, (error) => "error:" + (error?.message ?? error));
      await ws.close();
      return { outcome, fired: trap.fired() };
    };
    const fallback = await readWith("read-fallback", false);
    check(fallback.fired, `${kind} checks-only read trap fired`);
    check(fallback.outcome === "SECRET", `${kind} checks-only read leaks the outside file (control)`, String(fallback.outcome));
    const dirfd = await readWith("read-dirfd", true);
    check(dirfd.fired, `${kind} dirfd read trap fired`);
    check(dirfd.outcome !== "SECRET", `${kind} dirfd read never follows the swapped parent`, String(dirfd.outcome));
  }

  // Catches: a final component replaced by a symbolic link is never read through.
  {
    for (const rooted of [false, true]) {
      const name = "final-" + (rooted ? "dirfd" : "checks");
      const outside = join(t.base, "outside-" + name);
      const { ws, root } = await t.open(name, { rooted });
      await mkdir(join(root, "d"), { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(root, "d/f.txt"), "inside");
      await writeFile(join(outside, "secret.txt"), "SECRET");
      const trap = attackAfter(t.env, join(root, "d/f.txt"), async () => {
        await rm(join(root, "d/f.txt"));
        await symlink(join(outside, "secret.txt"), join(root, "d/f.txt"));
      });
      const reader = await new Workspace({
        env: trap.env, root, journalPath: join(t.base, "journal-" + name + "-2.json"), context: ctx, rooted,
      }).open();
      const outcome = await reader.read("d/f.txt").then((value) => value.content, (error) => "error:" + (error?.message ?? error));
      check(outcome !== "SECRET", `${kind} ${rooted ? "dirfd" : "checks"} refuses a final link`, String(outcome));
      await ws.close();
    }
  }

  // An environment without exec keeps working through the path-based checks.
  {
    const { ws, root } = await t.open("no-exec", { env: withoutExec(t.env), rooted: true });
    check(ws.mode === "checks", `${kind} falls back without exec`, ws.mode);
    const written = await ws.write({ path: "a.txt", content: "kept", expectedVersion: "absent", operationId: "w9" });
    const read = await ws.read("a.txt");
    check(written.status === "applied" && read.content === "kept", `${kind} fallback still reads and writes`);
    await ws.close();
  }

  await t.env.cleanup?.(ctx);
  await t.close();
  await rm(t.base, { recursive: true, force: true });
}

await await scenario("node");
await await scenario("local");
console.log(`\n${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
