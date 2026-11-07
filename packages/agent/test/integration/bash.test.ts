import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
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

    assert.equal((await readFile(join(root, "b.txt"), "utf8")).trim(), "inside");
    await assert.rejects(readFile(join(root, "..", "escape.txt"), "utf8"));
  });
});
