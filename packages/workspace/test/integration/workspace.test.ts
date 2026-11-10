import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdir, readdir, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Crash, Denied, FileFailure, Workspace } from "../../src/index.ts";
import { DIRFD_TARGET, openWorkspace, rootOf, withTarget } from "../support.ts";

const targets = [DIRFD_TARGET] as const;

for (const testTarget of targets) {
  test(testTarget.label + ": a write applies and a read sees it", async () => {
    await withTarget(testTarget, async (target) => {
      const workspace = await openWorkspace(target, "roundtrip");
      const applied = await workspace.write({
        path: "a.txt",
        content: "one",
        expectedVersion: "absent",
        operationId: "w1",
      });

      assert.equal(applied.status, "applied");
      const read = await workspace.read("a.txt");

      assert.equal(read.content, "one");
      assert.equal(read.version, applied.status === "applied" ? applied.version : "");
      await workspace.close();
    });
  });

  test(
    testTarget.label + ": a write from a stale version conflicts and does not overwrite",
    async () => {
      await withTarget(testTarget, async (target) => {
        const workspace = await openWorkspace(target, "conflict");
        await workspace.write({
          path: "a.txt",
          content: "v1",
          expectedVersion: "absent",
          operationId: "w1",
        });
        const v1 = (await workspace.read("a.txt")).version;
        await workspace.write({
          path: "a.txt",
          content: "v2",
          expectedVersion: v1,
          operationId: "w2",
        });

        const stale = await workspace.write({
          path: "a.txt",
          content: "v3",
          expectedVersion: v1,
          operationId: "w3",
        });

        assert.equal(stale.status, "conflict");
        assert.notEqual(stale.status === "conflict" ? stale.currentVersion : undefined, v1);
        assert.equal((await workspace.read("a.txt")).content, "v2");
        await workspace.close();
      });
    },
  );

  test(testTarget.label + ": replaying an operation returns the recorded result", async () => {
    await withTarget(testTarget, async (target) => {
      const workspace = await openWorkspace(target, "replay");
      await workspace.write({
        path: "a.txt",
        content: "v1",
        expectedVersion: "absent",
        operationId: "seed",
      });
      const base = (await workspace.read("a.txt")).version;
      const first = await workspace.write({
        path: "a.txt",
        content: "v2",
        expectedVersion: base,
        operationId: "w2",
      });
      await target.env.writeFile(join(rootOf(target, "replay"), "a.txt"), "external", ctx);

      const replay = await workspace.write({
        path: "a.txt",
        content: "v2",
        expectedVersion: base,
        operationId: "w2",
      });

      assert.deepEqual(replay, first);
      const external = await target.env.readTextFile(join(rootOf(target, "replay"), "a.txt"), ctx);
      assert.equal(external.ok ? external.value : undefined, "external");
      await workspace.close();
    });
  });

  for (const step of ["intent", "temp", "rename"] as const) {
    test(
      testTarget.label + ": a crash at " + step + " is settled by recover and retry",
      async () => {
        await withTarget(testTarget, async (target) => {
          const name = "crash-" + step;
          const first = await openWorkspace(target, name);
          await first.write({
            path: "a.txt",
            content: "v1",
            expectedVersion: "absent",
            operationId: "seed",
          });
          const base = (await first.read("a.txt")).version;

          const crashing = await openWorkspace(target, name, { crashAt: step });
          await assert.rejects(
            crashing.write({
              path: "a.txt",
              content: "v2",
              expectedVersion: base,
              operationId: "crash",
            }),
            Crash,
          );

          const fresh = await openWorkspace(target, name);
          const settled = await fresh.recover();
          assert.deepEqual(settled, [
            { operationId: "crash", status: step === "rename" ? "applied" : "pending" },
          ]);

          const retry = await fresh.write({
            path: "a.txt",
            content: "v2",
            expectedVersion: base,
            operationId: "crash",
          });

          assert.equal(retry.status, "applied");
          assert.equal((await fresh.read("a.txt")).content, "v2");
          await fresh.close();
        });
      },
    );
  }

  test(
    testTarget.label + ": a settled write that a stranger replaced afterwards is unknown",
    async () => {
      await withTarget(testTarget, async (target) => {
        const name = "stranger";
        const first = await openWorkspace(target, name);
        await first.write({
          path: "a.txt",
          content: "v1",
          expectedVersion: "absent",
          operationId: "seed",
        });
        const base = (await first.read("a.txt")).version;

        const crashing = await openWorkspace(target, name, { crashAt: "rename" });
        await assert.rejects(
          crashing.write({
            path: "a.txt",
            content: "ours",
            expectedVersion: base,
            operationId: "lost",
          }),
          Crash,
        );
        await target.env.writeFile(join(target.base, "root-" + name, "a.txt"), "stranger", ctx);

        const fresh = await openWorkspace(target, name);
        assert.deepEqual(await fresh.recover(), [{ operationId: "lost", status: "unknown" }]);
        const replay = await fresh.write({
          path: "a.txt",
          content: "ours",
          expectedVersion: base,
          operationId: "lost",
        });

        assert.equal(replay.status, "unknown");
        await fresh.close();
      });
    },
  );

  test(testTarget.label + ": a replaced root is refused and audited", async () => {
    await withTarget(testTarget, async (target) => {
      const workspace = await openWorkspace(target, "root-swap");
      await workspace.write({
        path: "a.txt",
        content: "one",
        expectedVersion: "absent",
        operationId: "w1",
      });
      const root = rootOf(target, "root-swap");
      await rename(root, root + "-old");

      await assert.rejects(workspace.read("a.txt"), Denied);
      await assert.rejects(
        workspace.write({
          path: "a.txt",
          content: "two",
          expectedVersion: "absent",
          operationId: "w2",
        }),
        Denied,
      );

      assert.ok(workspace.auditLog.filter((entry) => entry.denied).length >= 2);
      assert.equal(
        await target.env.exists(root, ctx).then((result) => result.ok && result.value),
        false,
      );
      await rename(root + "-old", root);
      await workspace.close();
    });
  });

  test(testTarget.label + ": a corrupt journal fails loudly", async () => {
    await withTarget(testTarget, async (target) => {
      const workspace = await openWorkspace(target, "corrupt");
      await workspace.write({
        path: "a.txt",
        content: "one",
        expectedVersion: "absent",
        operationId: "w1",
      });
      const journalPath = join(target.base, "journal-corrupt.json");
      await target.env.writeFile(journalPath, JSON.stringify({ ops: 5 }), ctx);

      await assert.rejects(
        Workspace.open({
          env: target.env,
          root: join(target.base, "root-corrupt"),
          journalPath,
          context: ctx,
        }),
      );
      await workspace.close();
    });
  });

  test(testTarget.label + ": git and traversal paths are refused", async () => {
    await withTarget(testTarget, async (target) => {
      const workspace = await openWorkspace(target, "paths");

      await assert.rejects(
        workspace.write({
          path: ".git/config",
          content: "x",
          expectedVersion: "absent",
          operationId: "w1",
        }),
        Denied,
      );
      await assert.rejects(workspace.read("../outside.txt"), Denied);
      await assert.rejects(workspace.read("/etc/passwd"), Denied);
      await assert.rejects(workspace.read("a/../../x"), Denied);
      await workspace.close();
    });
  });

  // The dirfd helper is what makes this "unknown" instead of "conflict".
  test(
    testTarget.label +
      ": a parent swapped for a link before the rename is unknown and nothing escapes",
    async () => {
      await withTarget(testTarget, async (target) => {
        const workspace = await openWorkspace(target, "swap");
        await target.env.createDir(join(rootOf(target, "swap"), "d"), { recursive: true }, ctx);
        await workspace.write({
          path: "d/f.txt",
          content: "one",
          expectedVersion: "absent",
          operationId: "seed",
        });
        const base = (await workspace.read("d/f.txt")).version;
        const outside = join(target.base, "outside");
        await mkdir(outside, { recursive: true });

        const trapped = await openWorkspace(target, "swap", {
          beforeRename: async () => {
            await rename(join(rootOf(target, "swap"), "d"), join(rootOf(target, "swap"), "d-old"));
            await symlink(outside, join(rootOf(target, "swap"), "d"));
          },
        });
        const result = await trapped.write({
          path: "d/f.txt",
          content: "two",
          expectedVersion: base,
          operationId: "swap",
        });

        assert.equal(result.status, "unknown");
        assert.deepEqual(await readdir(outside), []);
        await trapped.close();
        await workspace.close();
      });
    },
  );
}

for (const testTarget of targets) {
  test(testTarget.label + ": a write into a missing directory fails like a rename", async () => {
    await withTarget(testTarget, async (target) => {
      const workspace = await openWorkspace(target, "missing-parent");
      const failure = await workspace
        .write({ path: "nope/f.txt", content: "x", expectedVersion: "absent", operationId: "w1" })
        .then(
          () => undefined,
          (error: Error) => error,
        );

      assert.ok(failure instanceof FileFailure);
      assert.equal(failure.code, "not_found");
      await workspace.close();
    });
  });
}
