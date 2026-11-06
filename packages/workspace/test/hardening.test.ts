import test from "node:test";
import assert from "node:assert/strict";
import * as v from "valibot";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Denied, FileFailure } from "../src/index.ts";
import { KINDS, openWorkspace, rootOf, withTarget } from "./support.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

for (const kind of KINDS) {
  // Catches: operationId was spliced into the temp path, so "../" wrote outside the root.
  test(kind + ": a hostile operationId is refused and nothing escapes", async () => {
    await withTarget(kind, async (target) => {
      const workspace = await openWorkspace(target, "op-id");
      for (const operationId of ["../escape", "a/b", "..", "x\u0000y", "x".repeat(65)]) {
        await assert.rejects(
          workspace.write({ path: "a.txt", content: "x", expectedVersion: "absent", operationId }),
          Denied,
        );
      }

      const outside = (await readdir(target.base)).filter((name) => name.includes("escape"));
      assert.deepEqual(outside, []);
      await workspace.close();
    });
  });

  // Catches: the journal stored the caller's id in the temp path, which is what escaped.
  test(kind + ": the temp name is ours, not the caller's id", async () => {
    await withTarget(kind, async (target) => {
      const name = "temp-name";
      const workspace = await openWorkspace(target, name);
      await workspace.write({
        path: "a.txt",
        content: "one",
        expectedVersion: "absent",
        operationId: "op-1",
      });
      const journal = v.parse(
        v.object({ ops: v.record(v.string(), v.object({ temp: v.string() })) }),
        JSON.parse(await readFile(join(target.base, "journal-" + name + ".json"), "utf8")),
      );

      assert.equal(journal.ops["op-1"]?.temp.includes("op-1"), false);
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
}
