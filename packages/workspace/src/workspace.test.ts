import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { expect, test } from "vitest";
import { Denied } from "./errors.ts";
import type { AuditEntry } from "./types.ts";
import { Workspace } from "./workspace.ts";

// Catches: auditLog handed out the journal's array, so a caller could append to or edit the trail.
test("auditLog returns copies that cannot change the stored trail", async () => {
  const base = await mkdtemp(join(tmpdir(), "hns-audit-"));
  const root = join(base, "root");
  await mkdir(root);
  const env = new NodeExecutionEnv({ cwd: root });
  const workspace = await Workspace.open({
    env,
    root,
    journalPath: join(base, "journal.json"),
    context: ctx,
    rooted: false,
  });
  try {
    await expect(workspace.read("../outside")).rejects.toThrow(Denied);
    const first = workspace.auditLog;
    expect(first).toHaveLength(1);
    // SAFETY: The getter types the array readonly; this test writes through the
    // runtime view to prove the stored journal is not reachable that way.
    const mutable = first as AuditEntry[];
    mutable.push({
      at: new Date().toISOString(),
      operationId: null,
      path: "forged.txt",
      reason: "forged",
      denied: true,
    });
    Object.assign(mutable[0] ?? {}, { reason: "rewritten" });

    const again = workspace.auditLog;

    expect(again).toHaveLength(1);
    expect(again[0]?.reason).toBe("parent segment");
  } finally {
    await workspace.close();
    await rm(base, { recursive: true, force: true });
  }
});
