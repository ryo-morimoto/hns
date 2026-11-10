import { expect, test } from "vitest";
import { LOCAL_TARGET, openWorkspace, withTarget } from "../support.ts";

// Catches: the local daemon wiring opens but does not round-trip a write and read.
test("the local daemon opens, writes and reads a workspace", async () => {
  await withTarget(LOCAL_TARGET, async (target) => {
    const workspace = await openWorkspace(target, "daemon-smoke");
    expect(workspace.mode).toBe("dirfd");
    const applied = await workspace.write({
      path: "a.txt",
      content: "one",
      expectedVersion: "absent",
      operationId: "w1",
    });
    expect(applied.status).toBe("applied");
    expect((await workspace.read("a.txt")).content).toBe("one");
    await workspace.close();
  });
});
