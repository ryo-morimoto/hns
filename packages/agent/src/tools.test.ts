import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, ToolTask } from "@earendil-works/pi-durable";
import type { EntryRecord, JsonObject } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { AuditEvent, PolicyDecision } from "@hns/core/capability";
import { Workspace } from "@hns/workspace";
import type { AgentEvent } from "./events.ts";
import type { ShellAccess } from "./shell.ts";
import { toolNames, workspaceTools } from "./tools.ts";
import { definitionOf } from "./capability.ts";
import * as v from "valibot";

/** What one model-issued call settled as, and the text the model would read. */
interface Outcome {
  readonly status: string;
  /** Whether the model reads the result as a failure (the transcript message's `isError`). */
  readonly isError: boolean;
  readonly result: string;
}

interface Fixture {
  readonly root: string;
  readonly workspace: Workspace;
  readonly shell: ShellAccess;
  readonly events: AgentEvent[];
  readonly audits: AuditEvent[];
  /** Run one call exactly as the model makes it: an assistant entry, then pi-durable's own ToolTask. */
  readonly call: (name: string, args: JsonObject) => Promise<Outcome>;
}

/** The transcript entry of one tool call's result. */
function matchesCall(entry: EntryRecord, callId: string): boolean {
  if (entry.kind !== "pi.tool-result") return false;
  const message = entry.model?.[0];
  return message !== undefined && "toolCallId" in message && message.toolCallId === callId;
}

/** The text a tool result gives the model. */
function resultText(entry: EntryRecord | undefined): string {
  const message = entry?.model?.[0];
  if (message === undefined || message.role !== "toolResult") return "";
  const content = message.content;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/** Whether the model reads the result as a failure. */
function isFailed(entry: EntryRecord | undefined): boolean {
  const message = entry?.model?.[0];
  return message !== undefined && message.role === "toolResult" && message.isError === true;
}

/** A real workspace and a real harness; no model runs, only its tool calls do. */
async function withTools(
  run: (fixture: Fixture) => Promise<void>,
  options: {
    readonly kind?: ShellAccess["kind"] | undefined;
    readonly audit?: ((event: AuditEvent) => Promise<void>) | undefined;
  } = {},
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "hns-tools-"));
  const root = join(base, "root");
  await mkdir(root);
  const env = new NodeExecutionEnv({ cwd: root });
  const workspace = await Workspace.open({
    env,
    root,
    journalPath: join(base, "journal.json"),
    context: BACKGROUND_CONTEXT,
    rooted: false,
  });
  await workspace.write({
    path: "a.txt",
    content: "v1",
    expectedVersion: "absent",
    operationId: "seed",
  });
  const shell: ShellAccess =
    options.kind === "sandboxed"
      ? { kind: "sandboxed", env }
      : { kind: "disabled", env, reason: "no exec in this test" };
  const events: AgentEvent[] = [];
  const audits: AuditEvent[] = [];
  let eventId = 0;
  const registry = createRegistry();
  registry.install(
    workspaceTools({
      workspace,
      shell,
      onEvent: (event: AgentEvent) => events.push(event),
      audit:
        options.audit ??
        (async (event) => {
          audits.push(event);
        }),
      auditIdentity: {
        workspaceId: "w1",
        sessionId: "s1",
        eventId: () => {
          eventId += 1;
          return "e" + String(eventId);
        },
      },
    }),
  );
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry, env: () => shell.env },
    BACKGROUND_CONTEXT,
  );
  try {
    const conversation = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    let call = 0;
    const callOnce = async (name: string, args: JsonObject): Promise<Outcome> => {
      call += 1;
      const id = "call_" + String(call);
      const taskId = await harness.commit(async (tx) => {
        const assistant = await tx.appendEntry(conversation.id, {
          kind: "pi.assistant",
          model: [
            fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" }),
          ],
        });
        const task = await tx.createTask(
          ToolTask,
          { kind: "model", assistant: assistant.id, callId: id },
          { ownership: { kind: "conversation" }, conversationId: conversation.id },
        );
        return task;
      }, BACKGROUND_CONTEXT);
      const settled = await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
      const outcome = settled.state.outcome;
      // Every status but "completed" carries why; a test that expects one shows the reason.
      const status = outcome.status;
      const page = await conversation.entries(
        { order: "descending" },
        20,
        undefined,
        BACKGROUND_CONTEXT,
      );
      const entry = page.items.find((item) => matchesCall(item, id));
      return { status, isError: isFailed(entry), result: resultText(entry) };
    };
    await run({
      root,
      workspace,
      shell,
      events,
      audits,
      call: callOnce,
    });
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await workspace.close();
    await rm(base, { recursive: true, force: true });
  }
}

/** The newest audit row of one kind, for a call. */
const lastEvent = (
  audits: readonly AuditEvent[],
  event: AuditEvent["event"],
): AuditEvent | undefined => audits.filter((row) => row.event === event).at(-1);

/**
 * The decision a call was recorded under: the contract puts it on the result row only, and the first
 * result row of a call is the one that decided it (a refused call may also get a harness result).
 */
const decisionOf = (audits: readonly AuditEvent[]): PolicyDecision | undefined => {
  const result = audits.find((event) => event.event === "tool.result");
  return result?.event === "tool.result" ? result.decision : undefined;
};

describe("registration (C5)", () => {
  test("a disabled shell registers read_file and write_file, not bash", async () => {
    await withTools(async ({ workspace, shell }) => {
      expect(toolNames(workspaceTools({ workspace, shell }))).toEqual(["read_file", "write_file"]);
    });
  });

  // Catches: an unsandboxed exec fallback (D025), where bash would run with the host's access.
  test("a sandboxed shell registers bash", async () => {
    await withTools(
      async ({ workspace, shell }) => {
        expect(toolNames(workspaceTools({ workspace, shell }))).toEqual([
          "read_file",
          "write_file",
          "bash",
        ]);
      },
      { kind: "sandboxed" },
    );
  });
});

describe("arguments (C3)", () => {
  // Catches: an extra key from the model reaching the workspace, where it would be silently ignored.
  test("an unknown key is refused by the harness before the tool runs, and no call is recorded", async () => {
    await withTools(async ({ call, audits, events }) => {
      const outcome = await call("read_file", { path: "a.txt", mode: "rb" });
      expect(outcome.isError).toBe(true);
      // pi-durable's own validation refuses it before `beforeTool`: the tool never ran, no `tool.call`
      // was written, and only the settled result is recorded (with the contract's closest code).
      expect(events.filter((event) => event.event === "tool.call")).toEqual([]);
      expect(audits.map((event) => event.event)).toEqual(["tool.result"]);
      expect(decisionOf(audits)).toMatchObject({ outcome: "deny", code: "unsupported" });
    });
  });

  // The tool's own strictObject is the second check: the manifest declares exactly its schema's keys,
  // and an object path that skipped pi-durable's validation would still be refused here.
  test("the tool's own schema refuses an unknown key", async () => {
    for (const definition of ["read_file", "write_file", "bash"] as const) {
      const parsed = v.safeParse(definitionOf(definition).schema, { path: "a.txt", extra: 1 });
      expect(parsed.success, definition).toBe(false);
    }
  });

  test("a well-formed call reads the file", async () => {
    await withTools(async ({ call }) => {
      const outcome = await call("read_file", { path: "a.txt" });
      expect(outcome.isError).toBe(false);
      expect(JSON.parse(outcome.result)).toMatchObject({ ok: true, content: "v1" });
    });
  });
});

describe("paths (C4)", () => {
  for (const path of ["../secret.txt", "/etc/passwd", "a/../../secret.txt"]) {
    test(path + " is refused with path_outside_root", async () => {
      await withTools(async ({ call, audits }) => {
        const outcome = await call("read_file", { path });
        // The model reads the harness's refusal result; the denial code, and that nothing ran, are in
        // the audit: the decision denies it, and the call has no `argsHash` (nothing was admitted).
        expect(outcome.isError).toBe(true);
        // The model reads the harness's refusal of the call, in words, with no argument echoed back.
        expect(outcome.result).toContain("inside the workspace root");
        expect(outcome.result).not.toContain(path);
        expect(decisionOf(audits)).toMatchObject({ outcome: "deny", code: "path_outside_root" });
        // A refused call never became one the contract can name: the row carries no hash at all.
        expect(lastEvent(audits, "tool.call")?.argsHash).toBeUndefined();
      });
    });
  }

  // The contract's spelling cannot see a link; the resolved path must still be inside the root.
  test("a symlink that leaves the root is refused", async () => {
    await withTools(async ({ call, root, audits }) => {
      await symlink(tmpdir(), join(root, "out"));
      const outcome = await call("read_file", { path: "out/anything.txt" });
      expect(outcome.isError).toBe(true);
      expect(decisionOf(audits)).toMatchObject({ code: "path_outside_root" });
    });
  });

  test("a symlink that stays inside the root is allowed", async () => {
    await withTools(async ({ call, root }) => {
      await symlink(join(root, "a.txt"), join(root, "alias.txt"));
      const outcome = await call("read_file", { path: "alias.txt" });
      expect(JSON.parse(outcome.result)).toMatchObject({ ok: true, content: "v1" });
    });
  });
});

describe("audit (C6)", () => {
  test("a success records a call and a result without the arguments or the content", async () => {
    await withTools(async ({ call, audits }) => {
      await call("read_file", { path: "a.txt" });

      expect(audits.map((event) => event.event)).toEqual(["tool.call", "tool.result"]);
      const called = audits[0];
      const result = audits[1];
      expect(called).toMatchObject({
        v: 1,
        workspaceId: "w1",
        sessionId: "s1",
        toolId: "read_file",
        toolVersion: "1",
        prevHash: null,
      });
      expect(called?.callHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(called?.argsHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(called?.manifestHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(decisionOf(audits)).toMatchObject({ outcome: "allow", policyRevision: 0 });
      const finished = audits.filter((event) => event.event === "tool.result")[0];
      if (finished?.event !== "tool.result") throw new Error("no tool.result was recorded");
      expect(finished.durationMs).toBeTypeOf("number");
      expect(result?.callHash).toBe(called?.callHash);
      expect(result?.callId).toBe(called?.callId);
      const serialized = JSON.stringify(audits);
      expect(serialized).not.toContain("a.txt");
      expect(serialized).not.toContain("v1");
    });
  });

  test("the observation carries the same identity and no arguments", async () => {
    await withTools(async ({ call, audits, events }) => {
      await call("read_file", { path: "a.txt" });
      const called = events.find((event) => event.event === "tool.call");
      const result = events.find((event) => event.event === "tool.result");
      expect(called).toMatchObject({
        tool: "read_file",
        callId: audits[0]?.callId,
        callHash: audits[0]?.callHash,
        manifestHash: audits[0]?.manifestHash,
      });
      // The decision is judged once the call settled, so only `tool.result` carries it (N6).
      expect(called !== undefined && "decision" in called).toBe(false);
      if (result?.event !== "tool.result") throw new Error("no tool.result observation");
      expect(result.durationMs).toBeTypeOf("number");
      expect(result.ok).toBe(true);
      expect(JSON.stringify(events)).not.toContain("a.txt");
    });
  });

  test("a refusal records a call and a result with the denial", async () => {
    await withTools(async ({ call, audits }) => {
      await call("read_file", { path: "../x" });
      expect(audits.map((event) => event.event)).toEqual(["tool.call", "tool.result"]);
      expect(decisionOf(audits)).toMatchObject({ outcome: "deny", code: "path_outside_root" });
    });
  });
});

describe("a result whose row cannot be written (B1)", () => {
  // Catches: pi-durable keeping the tool's own result when a hook throws, so an unrecorded output
  // still reached the model.
  test("a rejected tool.result audit replaces the result, and its output is not returned", async () => {
    await withTools(
      async ({ call }) => {
        const outcome = await call("read_file", { path: "a.txt" });
        expect(outcome.isError).toBe(true);
        expect(outcome.result).toContain("could not be recorded");
        // The file's content is what the tool had produced; it must not be what the model reads.
        expect(outcome.result).not.toContain("v1");
      },
      {
        audit: async (event) => {
          if (event.event === "tool.result") throw new Error("audit is down");
        },
      },
    );
  });
});

describe("fail closed (C8)", () => {
  // Catches: a call running with an audit row that never landed.
  test("a rejected tool.call audit blocks the call and nothing runs", async () => {
    const after = new Map<string, number>();
    await withTools(
      async ({ call, workspace }) => {
        const outcome = await call("write_file", {
          path: "a.txt",
          content: "v2",
          expectedVersion: "absent",
        });
        expect(outcome.isError).toBe(true);
        // The tool never ran: the file still has what it had before the turn.
        expect((await workspace.read("a.txt")).content).toBe("v1");
      },
      {
        audit: async (event) => {
          if (event.event === "tool.call") throw new Error("audit is down");
          after.set(event.event, (after.get(event.event) ?? 0) + 1);
        },
      },
    );
    // The harness still settles the blocked call, so its result is recorded; the refused write's
    // `tool.call` never was, and the file it would have written is untouched.
    expect(after.get("tool.result")).toBe(1);
  });

  // Catches: tool.call written while the tool already ran, so a crash leaves a run with no intent.
  test("tool.call is appended before the tool runs and tool.result after", async () => {
    const order: string[] = [];
    await withTools(
      async ({ call }) => {
        await call("read_file", { path: "a.txt" });
      },
      {
        audit: async (event) => {
          order.push(event.event);
        },
      },
    );
    expect(order).toEqual(["tool.call", "tool.result"]);
  });
});

describe("bash's arguments as the call names them", () => {
  // The contract's canonical JSON holds safe integers only: the timeout is milliseconds, and a
  // fractional one has no callHash at all.
  test("timeoutMs is positive milliseconds and timeout is not an argument", () => {
    const schema = definitionOf("bash").schema;
    expect(v.safeParse(schema, { command: "ls", timeoutMs: 10 }).success).toBe(true);
    expect(v.safeParse(schema, { command: "ls", timeoutMs: 10.5 }).success).toBe(false);
    expect(v.safeParse(schema, { command: "ls", timeoutMs: 0 }).success).toBe(false);
    // The harness's seconds are not an argument of this tool.
    expect(v.safeParse(schema, { command: "ls", timeout: 0.01 }).success).toBe(false);
    // The manifest's schema and the descriptor the harness validates with agree on the keys.
    const manifest = definitionOf("bash");
    expect(Object.keys(manifest.parameters.properties)).toEqual(["command", "timeoutMs"]);
  });

  test("a bash call is recorded and runs", async () => {
    await withTools(
      async ({ call, audits }) => {
        const outcome = await call("bash", { command: "true" });
        expect(outcome.isError).toBe(false);
        expect(lastEvent(audits, "tool.call")?.toolId).toBe("bash");
        expect(lastEvent(audits, "tool.call")?.argsHash).toMatch(/^[0-9a-f]{64}$/u);
      },
      { kind: "sandboxed" },
    );
  }, 30_000);
});

describe("bash's timeout vocabulary (B3)", () => {
  // Catches: a fractional timeout accepted under a second name and rounded into the call's hash.
  test("a seconds timeout is refused on the real path, and nothing runs", async () => {
    await withTools(
      async ({ call, audits }) => {
        const outcome = await call("bash", { command: "true", timeout: 0.01 });
        expect(outcome.isError).toBe(true);
        expect(audits.map((event) => event.event)).toEqual(["tool.call", "tool.result"]);
        expect(decisionOf(audits)).toMatchObject({ outcome: "deny", code: "unsupported" });
        // Nothing ran: the tool's own output never reached the model, and only the refusal did.
        expect(outcome.result).not.toContain("timeout");
        expect(lastEvent(audits, "tool.result")).toMatchObject({ durationMs: 0 });
      },
      { kind: "sandboxed" },
    );
  }, 30_000);

  // Catches: a timeout that was admitted but never handed to the tool (an allow that did not run).
  test("timeoutMs is admitted, runs, and its duration is the tool's", async () => {
    await withTools(
      async ({ call, audits }) => {
        const outcome = await call("bash", { command: "true", timeoutMs: 12 });
        expect(outcome.isError).toBe(false);
        expect(decisionOf(audits)).toMatchObject({ outcome: "allow" });
        expect(lastEvent(audits, "tool.call")?.argsHash).toMatch(/^[0-9a-f]{64}$/u);
        expect(lastEvent(audits, "tool.result")).toMatchObject({ event: "tool.result" });
      },
      { kind: "sandboxed" },
    );
  }, 30_000);

  test("a whole second is admitted and runs", async () => {
    await withTools(
      async ({ call }) => {
        const outcome = await call("bash", { command: "true", timeoutMs: 1000 });
        expect(outcome.isError).toBe(false);
      },
      { kind: "sandboxed" },
    );
  }, 30_000);

  // Catches: two spellings of one timeout hashing to one call.
  test("0.0123 seconds and 12 milliseconds are not the same call", async () => {
    await withTools(
      async ({ call, audits }) => {
        await call("bash", { command: "true", timeout: 0.0123 });
        // The seconds form never became a call: its row carries no hash at all.
        expect(lastEvent(audits, "tool.call")?.argsHash).toBeUndefined();
        await call("bash", { command: "true", timeoutMs: 12 });
        expect(lastEvent(audits, "tool.call")?.argsHash).toMatch(/^[0-9a-f]{64}$/u);
      },
      { kind: "sandboxed" },
    );
  }, 30_000);
});

describe("the harness's seconds are not the tool's argument", () => {
  test("bash's schema does not admit timeout", () => {
    const schema = definitionOf("bash").schema;
    // The harness accepts seconds in its own schema, but the call is admitted only over timeoutMs.
    expect(v.safeParse(schema, { command: "ls", timeout: 30 }).success).toBe(false);
  });

  // Catches: a fractional timeout, which the contract's canonical JSON cannot hash.
  test("a fractional timeoutMs is not admitted", () => {
    const schema = definitionOf("bash").schema;
    expect(v.safeParse(schema, { command: "ls", timeoutMs: 10 }).success).toBe(true);
    expect(v.safeParse(schema, { command: "ls", timeoutMs: 10.5 }).success).toBe(false);
  });
});
