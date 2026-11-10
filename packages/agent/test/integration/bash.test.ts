import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { sandboxStatus, withAgent } from "../support.ts";

// Catches: the bash tool escaping the workspace root through the sandbox.
test("bash runs inside the root and cannot write outside it", async (t) => {
  const status = await sandboxStatus();
  if (!status.available) {
    t.skip("bubblewrap is unavailable: " + status.reason);
    return;
  }
  await withAgent(async ({ agent, root, faux }) => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "echo inside > b.txt; echo escape > ../escape.txt" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("ran it"),
    ]);

    await agent.send("prove the sandbox");

    expect((await readFile(join(root, "b.txt"), "utf8")).trim()).toBe("inside");
    await expect(readFile(join(root, "..", "escape.txt"), "utf8")).rejects.toThrow();
  });
});
