import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdir, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { MutationResult } from "@hns/core";
import type { Context } from "@earendil-works/chord";
import type {
  ExecutionEnv,
  ExecutionError,
  FileError,
  Result,
  ShellExecResult,
} from "@earendil-works/pi-durable/env";
import { ForwardingEnv } from "../../src/env.ts";
import { Unavailable, Workspace } from "../../src/index.ts";
import { DIRFD_TARGET, openWorkspace, rootOf, swapParent, withTarget } from "../support.ts";
import type { Target } from "../support.ts";

/** An environment that runs the attack once, right after it resolved a path. */
class AttackEnv extends ForwardingEnv {
  readonly #watched: string;
  readonly #attack: () => Promise<void>;
  #fired = false;

  constructor(inner: ExecutionEnv, watched: string, attack: () => Promise<void>) {
    super(inner);
    this.#watched = watched;
    this.#attack = attack;
  }

  get fired(): boolean {
    return this.#fired;
  }

  override async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    const result = await super.canonicalPath(path, context);
    if (!this.#fired && path === this.#watched) {
      this.#fired = true;
      await this.#attack();
    }
    return result;
  }
}

/** An environment whose exec is unavailable, as on a host without the helper. */
class NoExecEnv extends ForwardingEnv {
  override exec(): Promise<Result<ShellExecResult, ExecutionError>> {
    return Promise.reject(new Error("no exec"));
  }
}

/** The status of a write, or the name of what it threw. */
async function outcomeOf(write: Promise<MutationResult>): Promise<string> {
  try {
    return (await write).status;
  } catch (error) {
    return error instanceof Error ? "error: " + error.name : "error: unknown";
  }
}

/** The content of d/f.txt in a workspace, or the name of what the read threw. */
async function contentOf(reader: Workspace): Promise<string> {
  try {
    return (await reader.read("d/f.txt")).content;
  } catch (error) {
    return error instanceof Error ? "error: " + error.name : "error: unknown";
  }
}

/** Flip root/name between a directory and a link to outside until stopped. */
async function churn(
  root: string,
  name: string,
  outside: string,
  state: { stop: boolean },
): Promise<void> {
  while (!state.stop) {
    await rename(join(root, name), join(root, name + "-old")).catch(() => undefined);
    await symlink(outside, join(root, name)).catch(() => undefined);
    await unlink(join(root, name)).catch(() => undefined);
    await rename(join(root, name + "-old"), join(root, name)).catch(() => undefined);
  }
}

/** A root with d/f.txt already written, so the next write replaces it. */
async function seeded(target: Target, name: string, rooted: boolean) {
  const outside = join(target.base, "outside-" + name);
  const workspace = await openWorkspace(target, name, { rooted });
  const root = rootOf(target, name);
  await mkdir(join(root, "d"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await workspace.write({
    path: "d/f.txt",
    content: "inside",
    expectedVersion: "absent",
    operationId: "seed",
  });
  const version = (await workspace.read("d/f.txt")).version;
  await workspace.close();
  return { root, outside, version };
}

const targets = [DIRFD_TARGET] as const;

for (const testTarget of targets) {
  test(testTarget.label + ": opens in dirfd mode", async () => {
    await withTarget(testTarget, async (target) => {
      const workspace = await openWorkspace(target, "mode");

      assert.equal(workspace.mode, "dirfd");
      await workspace.close();
    });
  });

  // Catches: the window between the parent re-check and rename(2). The path-based
  // fallback still loses it; the dirfd path is what closes it.
  test(
    testTarget.label + ": a write swapped after the last check escapes on the fallback",
    async () => {
      await withTarget(testTarget, async (target) => {
        const { root, outside, version } = await seeded(target, "fallback", false);
        const trap = new AttackEnv(target.env, join(root, "d"), () =>
          swapParent(root, "d", outside),
        );
        const trapped = await Workspace.open({
          env: trap,
          root,
          journalPath: join(target.base, "journal-fallback-2.json"),
          context: ctx,
          rooted: false,
        });

        const result = await trapped.write({
          path: "d/f.txt",
          content: "x",
          expectedVersion: version,
          operationId: "w1",
        });

        assert.ok(trap.fired);
        assert.deepEqual(await readdir(outside), ["f.txt"]);
        assert.equal(result.status, "unknown");
        assert.ok(trapped.auditLog.some((entry) => entry.reason === "escaped after rename"));
        await trapped.close();
      });
    },
  );

  // Catches: a parent swapped after the last check must not take the write with it.
  test(testTarget.label + ": the same swap is refused in dirfd mode", async () => {
    await withTarget(testTarget, async (target) => {
      const { root, outside, version } = await seeded(target, "dirfd", true);
      const trapped = await Workspace.open({
        env: target.env,
        root,
        journalPath: join(target.base, "journal-dirfd-2.json"),
        context: ctx,
        beforeRename: async () => {
          await swapParent(root, "d", outside);
        },
      });

      const result = await trapped.write({
        path: "d/f.txt",
        content: "x",
        expectedVersion: version,
        operationId: "w1",
      });

      assert.equal(result.status, "unknown");
      assert.deepEqual(await readdir(outside), []);
      await trapped.close();
    });
  });

  // Catches: repeated writes while the parent is swapped must never leak.
  test(testTarget.label + ": repeated writes while the parent is swapped stay inside", async () => {
    await withTarget(testTarget, async (target) => {
      const outside = join(target.base, "outside-churn");
      const workspace = await openWorkspace(target, "churn");
      const root = rootOf(target, "churn");
      await mkdir(join(root, "d"), { recursive: true });
      await mkdir(outside, { recursive: true });
      const state = { stop: false };
      const toggling = churn(root, "d", outside, state);
      const outcomes: string[] = [];
      let leaked = false;
      try {
        for (let index = 0; index < 20; index += 1) {
          const outcome = await outcomeOf(
            workspace.write({
              path: "d/f" + index + ".txt",
              content: "v" + index,
              expectedVersion: "absent",
              operationId: "churn-" + index,
            }),
          );
          outcomes.push(outcome);
          if ((await readdir(outside)).length > 0) leaked = true;
        }
      } finally {
        state.stop = true;
        await toggling;
      }

      assert.equal(leaked, false, JSON.stringify({ outside: await readdir(outside), outcomes }));
      // The churn is over; a normal write still applies. Requiring a churn write to apply was
      // flaky: under constant swapping every write can legitimately be refused.
      const settled = await outcomeOf(
        workspace.write({
          path: "after-churn.txt",
          content: "done",
          expectedVersion: "absent",
          operationId: "after-churn",
        }),
      );
      assert.equal(settled, "applied");
      await workspace.close();
    });
  });

  // Catches: a parent swapped after the resolve must not be followed by a read.
  test(testTarget.label + ": a read never follows a swapped parent", async () => {
    await withTarget(testTarget, async (target) => {
      const read = async (name: string, rooted: boolean) => {
        const outside = join(target.base, "outside-" + name);
        const workspace = await openWorkspace(target, name, { rooted });
        const root = rootOf(target, name);
        await mkdir(join(root, "d"), { recursive: true });
        await mkdir(outside, { recursive: true });
        await writeFile(join(root, "d/f.txt"), "inside");
        await writeFile(join(outside, "f.txt"), "SECRET");
        const trap = new AttackEnv(target.env, join(root, "d/f.txt"), () =>
          swapParent(root, "d", outside),
        );
        const reader = await Workspace.open({
          env: trap,
          root,
          journalPath: join(target.base, "journal-" + name + "-2.json"),
          context: ctx,
          rooted,
        });
        const content = await contentOf(reader);
        await reader.close();
        await workspace.close();
        return { content, fired: trap.fired };
      };

      const fallback = await read("read-fallback", false);
      assert.ok(fallback.fired, "the trap did not fire");
      assert.equal(fallback.content, "SECRET");

      const dirfd = await read("read-dirfd", true);
      assert.ok(dirfd.fired, "the trap did not fire");
      assert.notEqual(dirfd.content, "SECRET");
    });
  });

  // Catches: a final component replaced by a symbolic link is never read through.
  test(testTarget.label + ": a final link is refused in both modes", async () => {
    await withTarget(testTarget, async (target) => {
      for (const rooted of [false, true]) {
        const name = "final-" + (rooted ? "dirfd" : "checks");
        const outside = join(target.base, "outside-" + name);
        const workspace = await openWorkspace(target, name, { rooted });
        const root = rootOf(target, name);
        await mkdir(join(root, "d"), { recursive: true });
        await mkdir(outside, { recursive: true });
        await writeFile(join(root, "d/f.txt"), "inside");
        await writeFile(join(outside, "secret.txt"), "SECRET");
        const trap = new AttackEnv(target.env, join(root, "d/f.txt"), async () => {
          await rm(join(root, "d/f.txt"));
          await symlink(join(outside, "secret.txt"), join(root, "d/f.txt"));
        });
        const reader = await Workspace.open({
          env: trap,
          root,
          journalPath: join(target.base, "journal-" + name + "-2.json"),
          context: ctx,
          rooted,
        });

        const content = await contentOf(reader);

        assert.notEqual(content, "SECRET");
        await reader.close();
        await workspace.close();
      }
    });
  });

  test(testTarget.label + ": an environment without exec falls back and still works", async () => {
    await withTarget(testTarget, async (target) => {
      const workspace = await openWorkspace(target, "no-exec", {
        env: new NoExecEnv(target.env),
        rooted: true,
      });

      assert.equal(workspace.mode, "checks");
      const written = await workspace.write({
        path: "a.txt",
        content: "kept",
        expectedVersion: "absent",
        operationId: "w1",
      });

      assert.equal(written.status, "applied");
      assert.equal((await workspace.read("a.txt")).content, "kept");
      await workspace.close();
    });
  });
}
test("a required rooted helper refuses to open without exec", async () => {
  for (const testTarget of targets) {
    await withTarget(testTarget, async (target) => {
      await assert.rejects(
        openWorkspace(target, "required", { env: new NoExecEnv(target.env), rooted: "required" }),
        Unavailable,
      );
    });
  }
});
