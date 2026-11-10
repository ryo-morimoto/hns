import { expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Workspace } from "@hns/workspace";
import { createNoExecEnv, createSandboxEnv } from "@hns/workspace/sandbox";
import { Denied } from "@hns/workspace";
import { OperationIdSchema } from "@hns/core";
import * as v from "valibot";
import { openAgent, operationIdFor } from "../src/index.ts";
import type { ShellAccess } from "../src/index.ts";
import { sandboxStatus, toolResults, withAgent } from "./support.ts";

test("a turn reads a file and replaces it with the version it read", async () => {
  await withAgent(async ({ agent, workspace, root, faux }) => {
    const version = (await workspace.read("a.txt")).version;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_file", { path: "a.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(
        fauxToolCall("write_file", {
          path: "a.txt",
          content: "v2",
          expectedVersion: version,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);

    const turn = await agent.send("replace the file");

    expect(turn.settlement.status).toBe("done");
    expect(turn.text).toBe("done");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("v2");
  });
});

test("a write from a stale version comes back as a conflict value", async () => {
  await withAgent(async ({ agent, root, faux }) => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write_file", {
          path: "a.txt",
          content: "stale",
          expectedVersion: "sha256:old",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("conflict seen"),
    ]);

    const turn = await agent.send("write with a stale version");
    const results = toolResults(await agent.transcript());

    expect(turn.settlement.status).toBe("done");
    expect(
      results.some((text) => text.includes('"status":"conflict"')),
      results.join(" | "),
    ).toBe(true);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("v1");
  });
});

// Catches: a refused path aborting the run instead of reaching the model as a value.
test("a refused path is reported to the model, not thrown", async () => {
  await withAgent(async ({ agent, faux }) => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_file", { path: "../outside.txt" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("denied"),
    ]);

    const turn = await agent.send("read outside the root");
    const results = toolResults(await agent.transcript());

    expect(turn.settlement.status).toBe("done");
    expect(
      results.some((text) => text.includes('"status":"denied"')),
      results.join(" | "),
    ).toBe(true);
  });
});

test("bash is offered only when a sandbox is available", async () => {
  const status = await sandboxStatus();

  await withAgent(async ({ agent }) => {
    if (status.available) expect(agent.tools.includes("bash"), agent.tools.join(",")).toBe(true);
    else expect(agent.tools.includes("bash"), agent.tools.join(",")).toBe(false);
    expect(agent.tools.includes("read_file")).toBe(true);
    expect(agent.tools.includes("write_file")).toBe(true);
  });
});

test("observation events name the tool, its outcome, and the response", async () => {
  await withAgent(async ({ agent, events, faux }) => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_file", { path: "a.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("read it"),
    ]);

    await agent.send("read a.txt");

    const called = events.filter((event) => event.event === "tool.call");
    const finished = events.filter((event) => event.event === "tool.result");
    const answered = events.filter((event) => event.event === "agent.response");

    expect(called.length).toBe(1);
    expect(called[0]?.event === "tool.call" ? called[0].tool : "").toBe("read_file");
    expect(finished[0]?.event === "tool.result" ? finished[0].ok : false).toBe(true);
    expect(answered.length).toBe(1);
    expect(answered[0]?.event === "agent.response" ? answered[0].text : "").toBe("read it");
  });
});

// Catches: the model chose operationId, so repeating one silently swallowed the next write.
test("two writes in one turn both apply, because the call names the operation", async () => {
  await withAgent(async ({ agent, workspace, root, faux }) => {
    const first = (await workspace.read("a.txt")).version;
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write_file", { path: "a.txt", content: "v2", expectedVersion: first }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("read_file", { path: "a.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await agent.send("first write");
    const second = (await workspace.read("a.txt")).version;
    expect(second).not.toBe(first);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("v2");

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write_file", { path: "a.txt", content: "v3", expectedVersion: second }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    await agent.send("second write");

    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("v3");
  });
});

// Catches: read_file put the whole file in the model context (up to the 8 MiB workspace cap).
test("a large file is truncated in the tool result", async () => {
  await withAgent(async ({ agent, root, faux, workspace }) => {
    const big = "x".repeat(100 * 1024);
    await workspace.write({
      path: "big.txt",
      content: big,
      expectedVersion: "absent",
      operationId: "seed-big",
    });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_file", { path: "big.txt" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("read it"),
    ]);

    await agent.send("read the big file");
    const result = toolResults(await agent.transcript()).find((text) =>
      text.startsWith('{"ok":true'),
    );

    expect.assert(result !== undefined, "no read result");
    const parsed = JSON.parse(result);
    expect(parsed.truncated).toBe(true);
    expect(parsed.characters).toBe(big.length);
    expect(parsed.content.length).toBeLessThan(big.length);
    expect(await readFile(join(root, "big.txt"), "utf8")).toBe(big);
  });
});

// Catches: a cwd outside the root was accepted, so every relative tool path meant nothing.
test("a cwd outside the workspace root is refused", async () => {
  const base = await mkdtemp(join(tmpdir(), "hns-agent-cwd-"));
  const root = join(base, "root");
  await mkdir(root);
  const env = new NodeExecutionEnv({ cwd: root });
  const workspace = await Workspace.open({
    env,
    root,
    journalPath: join(base, "journal.json"),
    context: ctx,
  });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const status = await sandboxStatus();
  const shell: ShellAccess = status.available
    ? { kind: "sandboxed", env: createSandboxEnv(env, { root, bwrap: status.bwrap }) }
    : { kind: "disabled", env: createNoExecEnv(env, status), reason: status.reason };
  try {
    await expect(
      openAgent({
        storage: new MemoryStorage(),
        models,
        workspace,
        shell,
        model: { provider: "faux", modelId: "faux-1" },
        cwd: base,
        context: ctx,
      }),
    ).rejects.toThrow(Denied);
  } finally {
    await workspace.close();
    await rm(base, { recursive: true, force: true });
  }
});
// Catches: the agent's operationId had a colon, which the wire's OperationIdSchema rejects.
test("the agent's operationId obeys the wire format", () => {
  const callId = "tool:1793992940083:qazzmqq70wo";

  expect(() => v.parse(OperationIdSchema, operationIdFor(callId))).not.toThrow();
  expect(operationIdFor(callId)).not.toBe(operationIdFor(callId + "x"));
  expect(operationIdFor("a".repeat(100)).length).toBe(64);
});
