import { expect, test } from "vitest";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { err, FileError } from "@earendil-works/pi-durable/env";
import type { Result } from "@earendil-works/pi-durable/env";
import { ForwardingEnv } from "../../src/env.ts";
import { FileFailure, Unavailable, Workspace } from "../../src/index.ts";
import { DIRFD_TARGET, openWorkspace, rootOf, withTarget } from "../support.ts";

const targets = [DIRFD_TARGET] as const;

/** An environment that fails journal renames on demand, keeping every temp name it saw. */
class FailJournalSaveEnv extends ForwardingEnv {
  readonly journalTemps: string[] = [];
  #remaining = 0;

  /** Fail the next count journal saves. */
  failNext(count: number): void {
    this.#remaining = count;
  }

  override async renameFile(
    sourcePath: string,
    destinationPath: string,
    context: Context,
  ): Promise<Result<void, FileError>> {
    if (sourcePath.includes(".json.tmp-")) this.journalTemps.push(sourcePath);
    if (this.#remaining > 0 && sourcePath.includes(".json.tmp-")) {
      this.#remaining -= 1;
      return err(new FileError("unknown", "injected save failure", sourcePath));
    }
    return super.renameFile(sourcePath, destinationPath, context);
  }
}

for (const testTarget of targets) {
  // Catches: two Workspaces shared one journal, so each save overwrote the other's view.
  test(testTarget.label + ": a second open of the same journal is unavailable", async () => {
    await withTarget(testTarget, async (target) => {
      const name = "double-open";
      const first = await openWorkspace(target, name);

      await expect(openWorkspace(target, name)).rejects.toThrow(Unavailable);

      await first.close();
      const second = await openWorkspace(target, name);
      expect(second.mode).toBe("dirfd");
      await second.close();
    });
  });

  // Catches: a failed open kept the claim, so the journal could never be opened again.
  test(testTarget.label + ": a failed open releases the journal claim", async () => {
    await withTarget(testTarget, async (target) => {
      const root = rootOf(target, "claim-release");
      const journalPath = join(target.base, "journal-claim-release.json");
      await target.env.createDir(root, { recursive: true }, ctx);
      await target.env.writeFile(journalPath, "{not json", ctx);

      await expect(
        Workspace.open({ env: target.env, root, journalPath, context: ctx, rooted: true }),
      ).rejects.toThrow();

      await target.env.writeFile(
        journalPath,
        JSON.stringify({ ops: {}, seq: 0, events: [], audit: [] }),
        ctx,
      );
      const workspace = await Workspace.open({
        env: target.env,
        root,
        journalPath,
        context: ctx,
        rooted: true,
      });

      expect(workspace.mode).toBe("dirfd");
      await workspace.close();
    });
  });

  // Catches: a fixed journal temp name let a failed save leave the file the next save reused.
  test(
    testTarget.label + ": a failed save leaves its own temp and the next save lands",
    async () => {
      await withTarget(testTarget, async (target) => {
        const name = "save-failure";
        const failing = new FailJournalSaveEnv(target.env);
        const workspace = await openWorkspace(target, name, { env: failing });
        await workspace.write({
          path: "a.txt",
          content: "v1",
          expectedVersion: "absent",
          operationId: "seed",
        });
        const base = (await workspace.read("a.txt")).version;

        failing.failNext(1);
        await expect(
          workspace.write({
            path: "a.txt",
            content: "v2",
            expectedVersion: base,
            operationId: "failed",
          }),
        ).rejects.toThrow(FileFailure);

        const applied = await workspace.write({
          path: "a.txt",
          content: "v3",
          expectedVersion: base,
          operationId: "retry",
        });

        expect(applied.status).toBe("applied");
        expect((await workspace.read("a.txt")).content).toBe("v3");
        expect(failing.journalTemps.length).toBeGreaterThanOrEqual(3);
        expect(new Set(failing.journalTemps).size).toBe(failing.journalTemps.length);
        expect(failing.journalTemps.every((path) => /.json.tmp-[0-9a-f-]{36}$/.test(path))).toBe(
          true,
        );
        const orphans = (await readdir(target.base)).filter((entry) =>
          entry.startsWith("journal-" + name + ".json.tmp-"),
        );
        expect(orphans).toHaveLength(1);
        await workspace.close();

        const fresh = await openWorkspace(target, name);
        expect((await fresh.read("a.txt")).content).toBe("v3");
        await fresh.close();
      });
    },
  );
}
