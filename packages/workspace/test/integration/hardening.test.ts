import { expect, test } from "vitest";
import * as v from "valibot";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Denied, FileFailure } from "../../src/index.ts";
import { DIRFD_TARGET, openWorkspace, rootOf, withTarget } from "../support.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const targets = [DIRFD_TARGET] as const;

for (const testTarget of targets) {
  // Catches: reusing an operationId for different content silently returned the old outcome.
  test(testTarget.label + ": an operationId cannot carry two different writes", async () => {
    await withTarget(testTarget, async (target) => {
      const workspace = await openWorkspace(target, "op-reuse");
      await workspace.write({
        path: "a.txt",
        content: "one",
        expectedVersion: "absent",
        operationId: "same",
      });
      const current = (await workspace.read("a.txt")).version;

      await expect(
        workspace.write({
          path: "a.txt",
          content: "two",
          expectedVersion: current,
          operationId: "same",
        }),
      ).rejects.toThrow(Denied);
      expect((await workspace.read("a.txt")).content).toBe("one");
      await workspace.close();
    });
  });

  // Catches: the journal kept every settled operation, so each write rewrote a growing file.
  test(testTarget.label + ": settled operations are trimmed from the journal", async () => {
    await withTarget(testTarget, async (target) => {
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
      expect(
        Object.keys(journal.ops).length,
        JSON.stringify(Object.keys(journal.ops)),
      ).toBeLessThanOrEqual(2);
      expect((await workspace.read("f-4.txt")).content).toBe("4");
      await workspace.close();
    });
  });

  // Catches: openAgent could accept a cwd outside the root, where relative tool paths mean nothing.
  test(testTarget.label + ": contains tells what is inside the root", async () => {
    await withTarget(testTarget, async (target) => {
      const workspace = await openWorkspace(target, "contains");
      const root = rootOf(target, "contains");

      expect(await workspace.contains(root)).toBe(true);
      expect(await workspace.contains(join(root, "nested", "file.txt"))).toBe(true);
      expect(await workspace.contains(join(target.base, "outside.txt"))).toBe(false);
      expect(await workspace.contains(target.base)).toBe(false);
      await workspace.close();
    });
  });
}

for (const testTarget of targets) {
  // Catches: operationId was spliced into the temp path. Invalid ids are refused; valid
  // ids never reach the internal temp name.
  test(testTarget.label + ": operationId never reaches a path", async () => {
    await withTarget(testTarget, async (target) => {
      const name = "op-id";
      const workspace = await openWorkspace(target, name);
      const applied = await workspace.write({
        path: "a.txt",
        content: "one",
        expectedVersion: "absent",
        operationId: "escape",
      });

      expect(applied.status).toBe("applied");
      const journal = v.parse(
        v.object({ ops: v.record(v.string(), v.object({ temp: v.string() })) }),
        JSON.parse(await readFile(join(target.base, "journal-" + name + ".json"), "utf8")),
      );
      const temp = journal.ops.escape?.temp ?? "";
      expect(temp).toMatch(/\/\.hns-tmp-[0-9a-f-]{36}$/);
      expect(temp.includes("escape")).toBe(false);
      await workspace.close();
    });
  });

  // Catches: a new directory in the root produced an unhandled rejection (EISDIR) and could crash.
  test(testTarget.label + ": watching survives a directory appearing in the root", async (t) => {
    const rejections: unknown[] = [];
    const onRejection = (reason: Error): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      await withTarget(testTarget, async (target) => {
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

    expect(rejections).toStrictEqual([]);
  });

  // Catches: a directory read surfaced as a raw FileError instead of a typed failure.
  test(testTarget.label + ": reading a directory is a FileFailure, not a defect", async () => {
    await withTarget(testTarget, async (target) => {
      const workspace = await openWorkspace(target, "dir-read");
      await mkdir(join(rootOf(target, "dir-read"), "dir"), { recursive: true });
      const failure = await workspace.read("dir").then(
        () => undefined,
        (error: Error) => error,
      );

      expect.assert(failure instanceof FileFailure);
      expect(failure.code).toBe("is_directory");
      await workspace.close();
    });
  });

  // Catches: two writes in flight overwrote each other's journal entry (lost update).
  test(testTarget.label + ": concurrent writes both survive a reopen", async () => {
    await withTarget(testTarget, async (target) => {
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

      expect(first.status).toBe("applied");
      expect(second.status).toBe("applied");
      await workspace.close();

      const fresh = await openWorkspace(target, "concurrent");
      expect(await fresh.recover()).toStrictEqual([]);
      expect((await fresh.read("a.txt")).content).toBe("a");
      expect((await fresh.read("b.txt")).content).toBe("b");
      await fresh.close();
    });
  });

  // Catches: a retried conflict applied later once the version came back.
  test(testTarget.label + ": a conflict is recorded and stays a conflict on retry", async () => {
    await withTarget(testTarget, async (target) => {
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
      expect(stale.status).toBe("conflict");

      await writeFile(join(rootOf(target, name), "a.txt"), "v1");
      const retry = await workspace.write({
        path: "a.txt",
        content: "v3",
        expectedVersion: v1,
        operationId: "w3",
      });

      expect(retry.status).toBe("conflict");
      expect((await workspace.read("a.txt")).content).toBe("v1");
      await workspace.close();
    });
  });

  // Catches: a direct workspace.write caller could bypass the HTTP operationId rule, and a
  // path-shaped id left a journal entry or a temp file, or the refusal left no audit line.
  test(testTarget.label + ": an invalid operationId is refused before writing", async () => {
    await withTarget(testTarget, async (target) => {
      const name = "op-invalid";
      const workspace = await openWorkspace(target, name);
      const root = rootOf(target, name);
      await expect(
        workspace.write({
          path: "bad.txt",
          content: "x",
          expectedVersion: "absent",
          operationId: "../../escape",
        }),
      ).rejects.toThrow(Denied);

      const entries = await readdir(root);
      expect(
        entries.filter(
          (entry) =>
            entry === "bad.txt" || entry.startsWith(".hns-tmp-") || entry.includes("escape"),
        ),
      ).toStrictEqual([]);
      const journal = v.parse(
        v.object({
          ops: v.record(v.string(), v.unknown()),
          audit: v.array(
            v.object({ operationId: v.nullable(v.string()), denied: v.literal(true) }),
          ),
        }),
        JSON.parse(await readFile(join(target.base, "journal-" + name + ".json"), "utf8")),
      );
      expect(Object.keys(journal.ops)).toStrictEqual([]);
      expect(journal.audit.map((entry) => [entry.operationId, entry.denied])).toStrictEqual([
        [null, true],
      ]);
      await workspace.close();
    });
  });
}
