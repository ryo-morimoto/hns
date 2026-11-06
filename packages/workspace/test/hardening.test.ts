import { test } from "vitest";
import assert from "node:assert/strict";
import * as v from "valibot";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Denied, FileFailure } from "../src/index.ts";
import { KINDS, openWorkspace, rootOf, withTarget } from "./support.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

for (const kind of KINDS) {
  // Catches: reusing an operationId for different content silently returned the old outcome.
  test(kind + ": an operationId cannot carry two different writes", async () => {
    await withTarget(kind, async (target) => {
      const workspace = await openWorkspace(target, "op-reuse");
      await workspace.write({
        path: "a.txt",
        content: "one",
        expectedVersion: "absent",
        operationId: "same",
      });
      const current = (await workspace.read("a.txt")).version;

      await assert.rejects(
        workspace.write({
          path: "a.txt",
          content: "two",
          expectedVersion: current,
          operationId: "same",
        }),
        Denied,
      );
      assert.equal((await workspace.read("a.txt")).content, "one");
      await workspace.close();
    });
  });

  // Catches: the journal kept every settled operation, so each write rewrote a growing file.
  test(kind + ": settled operations are trimmed from the journal", async () => {
    await withTarget(kind, async (target) => {
      const name = "op-trim";
      const workspace = await openWorkspace(target, name, { maxSettledOps: 2 });
      for (let index = 0; index < 5; index += 1) {
        await workspace.write({
          path: "f-" + index + ".txt",
          content: String(index),
          expectedVersion: "absent",
          operationId: "op-" + index,
        });
      }

      const journal = JSON.parse(
        await readFile(join(target.base, "journal-" + name + ".json"), "utf8"),
      );
      assert.ok(Object.keys(journal.ops).length <= 2, JSON.stringify(Object.keys(journal.ops)));
      assert.equal((await workspace.read("f-4.txt")).content, "4");
      await workspace.close();
    });
  });

  // Catches: openAgent could accept a cwd outside the root, where relative tool paths mean nothing.
  test(kind + ": contains tells what is inside the root", async () => {
    await withTarget(kind, async (target) => {
      const workspace = await openWorkspace(target, "contains");
      const root = rootOf(target, "contains");

      assert.equal(await workspace.contains(root), true);
      assert.equal(await workspace.contains(join(root, "nested", "file.txt")), true);
      assert.equal(await workspace.contains(join(target.base, "outside.txt")), false);
      assert.equal(await workspace.contains(target.base), false);
      await workspace.close();
    });
  });
}

for (const kind of KINDS) {
  // Catches: operationId was spliced into the temp path. Invalid ids are refused; valid
  // ids never reach the internal temp name.
  test(kind + ": operationId never reaches a path", async () => {
    await withTarget(kind, async (target) => {
      const name = "op-id";
      const workspace = await openWorkspace(target, name);
      const applied = await workspace.write({
        path: "a.txt",
        content: "one",
        expectedVersion: "absent",
        operationId: "escape",
      });

      assert.equal(applied.status, "applied");
      const journal = v.parse(
        v.object({ ops: v.record(v.string(), v.object({ temp: v.string() })) }),
        JSON.parse(await readFile(join(target.base, "journal-" + name + ".json"), "utf8")),
      );
      const temp = journal.ops.escape?.temp ?? "";
      assert.match(temp, /\/\.hns-tmp-[0-9a-f-]{36}$/);
      assert.equal(temp.includes("escape"), false);
      await workspace.close();
    });
  });

  // Catches: a new directory in the root produced an unhandled rejection (EISDIR) and could crash.
  test(kind + ": watching survives a directory appearing in the root", async (t) => {
    const rejections: unknown[] = [];
    const onRejection = (reason: Error): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      await withTarget(kind, async (target) => {
        const workspace = await openWorkspace(target, "watch-dir");
        const watcher = await workspace.startWatching().catch(() => undefined);
        if (watcher === undefined) {
          t.skip("the environment cannot watch");
          return;
        }
        await mkdir(join(rootOf(target, "watch-dir"), "subdir"), { recursive: true });
        await sleep(400);
        await workspace.close();
      });
    } finally {
      process.off("unhandledRejection", onRejection);
    }

    assert.deepEqual(rejections, []);
  });

  // Catches: a directory read surfaced as a raw FileError instead of a typed failure.
  test(kind + ": reading a directory is a FileFailure, not a defect", async () => {
    await withTarget(kind, async (target) => {
      const workspace = await openWorkspace(target, "dir-read");
      await mkdir(join(rootOf(target, "dir-read"), "dir"), { recursive: true });
      const failure = await workspace.read("dir").then(
        () => undefined,
        (error: Error) => error,
      );

      assert.ok(failure instanceof FileFailure);
      assert.equal(failure.code, "is_directory");
      await workspace.close();
    });
  });

  // Catches: two writes in flight overwrote each other's journal entry (lost update).
  test(kind + ": concurrent writes both survive a reopen", async () => {
    await withTarget(kind, async (target) => {
      const workspace = await openWorkspace(target, "concurrent");
      const [first, second] = await Promise.all([
        workspace.write({
          path: "a.txt",
          content: "a",
          expectedVersion: "absent",
          operationId: "a",
        }),
        workspace.write({
          path: "b.txt",
          content: "b",
          expectedVersion: "absent",
          operationId: "b",
        }),
      ]);

      assert.equal(first.status, "applied");
      assert.equal(second.status, "applied");
      await workspace.close();

      const fresh = await openWorkspace(target, "concurrent");
      assert.deepEqual(await fresh.recover(), []);
      assert.equal((await fresh.read("a.txt")).content, "a");
      assert.equal((await fresh.read("b.txt")).content, "b");
      await fresh.close();
    });
  });

  // Catches: a retried conflict applied later once the version came back.
  test(kind + ": a conflict is recorded and stays a conflict on retry", async () => {
    await withTarget(kind, async (target) => {
      const name = "conflict-retry";
      const workspace = await openWorkspace(target, name);
      await workspace.write({
        path: "a.txt",
        content: "v1",
        expectedVersion: "absent",
        operationId: "seed",
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

      await writeFile(join(rootOf(target, name), "a.txt"), "v1");
      const retry = await workspace.write({
        path: "a.txt",
        content: "v3",
        expectedVersion: v1,
        operationId: "w3",
      });

      assert.equal(retry.status, "conflict");
      assert.equal((await workspace.read("a.txt")).content, "v1");
      await workspace.close();
    });
  });

  // Catches: a direct workspace.write caller could bypass the HTTP operationId rule.
  test(kind + ": an invalid operationId is refused before writing", async () => {
    await withTarget(kind, async (target) => {
      const workspace = await openWorkspace(target, "op-invalid");
      const root = rootOf(target, "op-invalid");
      await assert.rejects(
        workspace.write({
          path: "bad.txt",
          content: "x",
          expectedVersion: "absent",
          operationId: "bad id",
        }),
        Denied,
      );
      assert.deepEqual(
        (await readdir(root)).filter((name) => name === "bad.txt"),
        [],
      );
      await workspace.close();
    });
  });
}
