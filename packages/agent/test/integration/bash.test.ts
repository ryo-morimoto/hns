import { readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent } from "../../src/index.ts";
import { sandboxStatus, withAgent } from "../support.ts";
import { requireBwrap } from "../../../../tools/test/cf-dev.ts";

interface Outcome {
  readonly ok: boolean;
  readonly ms: number;
}

/** How many times the run announced one tool. */
const callsFor = (events: readonly AgentEvent[], tool: string): number =>
  events.filter((event) => event.event === "tool.call" && event.tool === tool).length;

/** The outcomes the run reported for one tool, in emission order. */
const resultsFor = (events: readonly AgentEvent[], tool: string): Outcome[] =>
  events.flatMap((event) =>
    event.event === "tool.result" && event.tool === tool ? [{ ok: event.ok, ms: event.ms }] : [],
  );

// Catches: the bash tool escaping the workspace root through the sandbox.
test("bash runs inside the root and cannot write outside it", async (t) => {
  const status = await sandboxStatus();
  const why = status.available ? "" : status.reason;
  if (!requireBwrap(status.available, why)) {
    t.skip("bubblewrap is unavailable: " + why);
    return;
  }
  await withAgent(async ({ agent, events, root, faux }) => {
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
    expect(resultsFor(events, "bash")[0]?.ok).toBe(false);
  });
});

// Catches: bash was registered bare, so only the workspace tools emitted observations.
test("read_file, write_file, and bash each report a call and a result", async (t) => {
  const status = await sandboxStatus();
  const why = status.available ? "" : status.reason;
  if (!requireBwrap(status.available, why)) {
    t.skip("bubblewrap is unavailable: " + why);
    return;
  }
  await withAgent(async ({ agent, events, faux, workspace }) => {
    const version = (await workspace.read("a.txt")).version;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_file", { path: "a.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(
        fauxToolCall("write_file", { path: "a.txt", content: "v2", expectedVersion: version }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf ok" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);

    const turn = await agent.send("use every tool");

    expect(turn.settlement.status).toBe("done");
    for (const tool of ["read_file", "write_file", "bash"]) {
      expect(callsFor(events, tool), tool).toBe(1);
      const outcomes = resultsFor(events, tool);
      expect(outcomes.length, tool).toBe(1);
      const outcome = outcomes[0];
      assert.ok(outcome !== undefined, tool + " reported no result");
      expect(outcome.ok, tool).toBe(true);
      expect(outcome.ms, tool).toBeGreaterThanOrEqual(0);
    }
  });
});

// Catches: a command that exited nonzero was recorded as a success.
test("a nonzero exit is a failed tool result", async (t) => {
  const status = await sandboxStatus();
  const why = status.available ? "" : status.reason;
  if (!requireBwrap(status.available, why)) {
    t.skip("bubblewrap is unavailable: " + why);
    return;
  }
  await withAgent(async ({ agent, events, faux }) => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "exit 3" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("it failed"),
    ]);

    const turn = await agent.send("fail on purpose");
    const outcomes = resultsFor(events, "bash");

    expect(turn.settlement.status).toBe("done");
    expect(callsFor(events, "bash")).toBe(1);
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]?.ok).toBe(false);
  });
});

// Catches: an execution that threw left its call without a result.
test("a command that times out still reports a failed result", async (t) => {
  const status = await sandboxStatus();
  const why = status.available ? "" : status.reason;
  if (!requireBwrap(status.available, why)) {
    t.skip("bubblewrap is unavailable: " + why);
    return;
  }
  await withAgent(async ({ agent, events, faux }) => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30", timeout: 0.01 }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("timed out"),
    ]);

    const turn = await agent.send("run too long");
    const outcomes = resultsFor(events, "bash");

    expect(turn.settlement.status).toBe("done");
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]?.ok).toBe(false);
  });
});
