import { test } from "vitest";
import assert from "node:assert/strict";
import { LOCAL_TARGET, openWorkspace, withTarget } from "../support.ts";

// Catches: the local daemon wiring opens but does not round-trip a write and read.
test("the local daemon opens, writes and reads a workspace", async () => {
  await withTarget(LOCAL_TARGET, async (target) => {
    const workspace = await openWorkspace(target, "daemon-smoke");
    assert.equal(workspace.mode, "dirfd");
    const applied = await workspace.write({
      path: "a.txt",
      content: "one",
      expectedVersion: "absent",
      operationId: "w1",
    });
    assert.equal(applied.status, "applied");
    assert.equal((await workspace.read("a.txt")).content, "one");
    await workspace.close();
  });
});
