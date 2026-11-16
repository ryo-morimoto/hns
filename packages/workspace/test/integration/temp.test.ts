import { expect, test } from "vitest";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { err, FileError } from "@earendil-works/pi-durable/env";
import type { Result } from "@earendil-works/pi-durable/env";
import { ForwardingEnv } from "../../src/env.ts";
import { Crash } from "../../src/index.ts";
import { DIRFD_TARGET, openWorkspace, rootOf, withTarget } from "../support.ts";

const tempNames = async (root: string): Promise<string[]> =>
  (await readdir(root)).filter((entry) => entry.startsWith(".hns-tmp-"));

/** An environment whose remove refuses the workspace's temp files. */
class FailRemoveEnv extends ForwardingEnv {
  override remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    if (path.includes("/.hns-tmp-")) {
      return Promise.resolve(
        err(new FileError("permission_denied", "injected remove failure", path)),
      );
    }
    return super.remove(path, options, context);
  }
}

for (const testTarget of [DIRFD_TARGET] as const) {
  // Catches: a conflict found after the temp was written left the temp beside the root.
  test(testTarget.label + ": a write that ends in conflict leaves no temp", async () => {
    await withTarget(testTarget, async (target) => {
      const name = "temp-conflict";
      const root = rootOf(target, name);
      let raced = false;
      const workspace = await openWorkspace(target, name, {
        beforeRename: async () => {
          if (raced) await target.env.writeFile(join(root, "a.txt"), "external", ctx);
        },
      });
      await workspace.write({
        path: "a.txt",
        content: "v1",
        expectedVersion: "absent",
        operationId: "seed",
      });
      const base = (await workspace.read("a.txt")).version;
      raced = true;

      const result = await workspace.write({
        path: "a.txt",
        content: "v2",
        expectedVersion: base,
        operationId: "raced",
      });

      expect(result.status).toBe("conflict");
      expect(await tempNames(root)).toStrictEqual([]);
      expect((await workspace.read("a.txt")).content).toBe("external");
      await workspace.close();
    });
  });

  // Catches: a failed temp removal was dropped, so the orphan disappeared without a trace.
  test(testTarget.label + ": a temp that cannot be removed is audited", async () => {
    await withTarget(testTarget, async (target) => {
      const name = "temp-remove-failure";
      const root = rootOf(target, name);
      let raced = false;
      const workspace = await openWorkspace(target, name, {
        env: new FailRemoveEnv(target.env),
        beforeRename: async () => {
          if (raced) await target.env.writeFile(join(root, "a.txt"), "external", ctx);
        },
      });
      await workspace.write({
        path: "a.txt",
        content: "v1",
        expectedVersion: "absent",
        operationId: "seed",
      });
      const base = (await workspace.read("a.txt")).version;
      raced = true;

      const result = await workspace.write({
        path: "a.txt",
        content: "v2",
        expectedVersion: base,
        operationId: "raced",
      });

      expect(result.status).toBe("conflict");
      expect(
        workspace.auditLog.some((entry) => entry.reason.startsWith("cannot remove temp:")),
      ).toBe(true);
      expect(await tempNames(root)).toHaveLength(1);
      await workspace.close();
    });
  });

  // Catches: startup cleanup deleted the temp a pending intent still needs for recovery.
  test(testTarget.label + ": opening removes orphan temps and keeps a pending one", async () => {
    await withTarget(testTarget, async (target) => {
      const name = "temp-pending";
      const root = rootOf(target, name);
      const first = await openWorkspace(target, name);
      await first.write({
        path: "a.txt",
        content: "v1",
        expectedVersion: "absent",
        operationId: "seed",
      });
      const base = (await first.read("a.txt")).version;
      await first.close();

      const crashing = await openWorkspace(target, name, { crashAt: "temp" });
      await expect(
        crashing.write({
          path: "a.txt",
          content: "v2",
          expectedVersion: base,
          operationId: "crashed",
        }),
      ).rejects.toThrow(Crash);
      await crashing.close();

      const kept = await tempNames(root);
      expect(kept).toHaveLength(1);
      await writeFile(join(root, ".hns-tmp-orphan"), "orphan");

      const fresh = await openWorkspace(target, name);

      expect(await tempNames(root)).toStrictEqual(kept);
      expect(await fresh.recover()).toStrictEqual([{ operationId: "crashed", status: "pending" }]);
      await fresh.close();
    });
  });
}
