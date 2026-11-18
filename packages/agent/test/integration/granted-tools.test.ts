import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, ToolTask } from "@earendil-works/pi-durable";
import type { EntryRecord, JsonObject } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { isoTimestamp } from "@hns/core";
import { deny } from "@hns/core/capability";
import type { AuditEvent, SignedGrant, ToolCall } from "@hns/core/capability";
import type { GrantedAnswer } from "@hns/workspace/protocol";
import { Workspace } from "@hns/workspace";
import { sessionGrantPath } from "../../src/runtime.ts";
import { grantPathFor } from "../../src/session.ts";
import type { GrantAnswer, ToolContract } from "../../src/runtime.ts";
import type { GrantSource, ToolTransport } from "../../src/runtime.ts";
import { workspaceTools } from "../../src/tools.ts";
import type { GrantPathOf, WorkspaceGrants } from "../../src/tools.ts";

/**
 * The granted path through the tool hooks (0226 C1, C6): the agent asks for a grant, relays the
 * call, and runs nothing here.
 *
 * @remarks
 * The model is faux and the machine is a fake that answers what a test tells it, so what is proved
 * is the agent's half alone: the call goes to the relay **with the grant the issuer signed**, the
 * registered tool never touches the workspace (a write the machine "applied" did not change the
 * file here), the machine's decision is the audit's decision, a denial is the harness's refusal the
 * model reads (the (A) contract) and the run continues, and a grant that cannot be obtained runs
 * nothing (fail closed).
 */

/** What one model-issued call settled as. */
interface Outcome {
  readonly status: string;
  readonly isError: boolean;
  readonly text: string;
}

/** What the fake relay was asked, and what it answered. */
interface Relay {
  readonly calls: { readonly call: ToolCall; readonly grant: SignedGrant }[];
  answer: (call: ToolCall) => GrantedAnswer;
}

const GRANT: SignedGrant = {
  payload: {
    v: 1,
    grantId: "grant-1",
    workspaceId: "w1",
    sessionId: "s1",
    machineId: "m1",
    toolId: "read_file",
    toolVersion: "1",
    manifestHash: "a".repeat(64),
    scope: { kind: "read", roots: ["."] },
    issuedAt: isoTimestamp("2026-11-18T00:00:00.000Z"),
    expiresAt: isoTimestamp("2026-11-18T00:01:00.000Z"),
    epoch: 1,
    policyHash: "b".repeat(64),
    maxCalls: 10,
    maxBytes: 4096,
    nonce: "nonce-1",
    alg: "Ed25519",
    keyId: "key-1",
  },
  signature: "signature-1",
};

const ALLOW = (_call: ToolCall): GrantedAnswer => ({
  decision: { outcome: "allow", policyRevision: 1, policyHash: "b".repeat(64), grantId: "grant-1" },
  grantId: "grant-1",
  // The machine answers a read's content base64 (its wire type), which the tool decodes.
  result: {
    kind: "read",
    content: Buffer.from("from the machine", "utf8").toString("base64"),
    version: "sha256:x",
    size: 16,
  },
});

/** A granted path whose issuer and relay are fakes a test watches. */
function grantedPath(options: {
  readonly answer?: GrantAnswer;
  readonly relay?: (call: ToolCall) => GrantedAnswer;
}) {
  const issued: ToolContract[] = [];
  const relay: Relay = { calls: [], answer: options.relay ?? ALLOW };
  const source: GrantSource = {
    async issue(request) {
      issued.push({
        manifest: {
          v: 1,
          toolId: request.toolId,
          version: request.toolVersion,
          descriptionHash: "c".repeat(64),
          parametersHash: "d".repeat(64),
          risk: "read",
          outputLimits: { maxBytes: 4096, maxLines: 100 },
        },
        manifestHash: request.manifestHash,
      });
      return options.answer ?? { ok: true, grant: GRANT };
    },
  };
  const transport: ToolTransport = {
    async call(input) {
      relay.calls.push({ call: input.call, grant: input.grant });
      return relay.answer(input.call);
    },
    async closeRun() {
      // The stub transport ends nothing in this test.
    },
  };
  const path = sessionGrantPath({ source, transport });
  return { grants: { source: path.source, transport: path.transport }, issued, relay };
}

/** Run one model call through a real harness and a real workspace. */
async function withGranted(
  run: (fixture: {
    readonly call: (name: string, args: JsonObject) => Promise<Outcome>;
    readonly audits: AuditEvent[];
    readonly root: string;
  }) => Promise<void>,
  grants: GrantPathOf | WorkspaceGrants,
  /**
   * What the hook's chooser was asked, when the test wants to see the run: the path is asked for
   * the call's own run (the conversation), and the test records it.
   */
  choose?: (runId: string) => WorkspaceGrants,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "hns-granted-"));
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
  const audits: AuditEvent[] = [];
  let eventId = 0;
  const registry = createRegistry();
  registry.install(
    workspaceTools({
      workspace,
      shell: { kind: "disabled", env, reason: "no exec in this test" },
      audit: async (event) => {
        audits.push(event);
      },
      auditIdentity: {
        workspaceId: "w1",
        sessionId: "s1",
        eventId: () => {
          eventId += 1;
          return "e" + String(eventId);
        },
      },
      // SAFETY: the parameter is either a fixed path (the caller's) or a chooser; the branch is
      // exactly that, and a fixed path answers every identity.
      grants:
        choose === undefined
          ? () => grants as WorkspaceGrants
          : (identity) =>
              identity?.conversationId === undefined ? undefined : choose(identity.conversationId),
    }),
  );
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry, env: () => env },
    BACKGROUND_CONTEXT,
  );
  try {
    const conversation = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    const callOnce = async (name: string, args: JsonObject): Promise<Outcome> => {
      const id = "call_" + crypto.randomUUID();
      const taskId = await harness.commit(async (tx) => {
        const assistant = await tx.appendEntry(conversation.id, {
          kind: "pi.assistant",
          model: [
            fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" }),
          ],
        });
        return await tx.createTask(
          ToolTask,
          { kind: "model", assistant: assistant.id, callId: id },
          { ownership: { kind: "conversation" }, conversationId: conversation.id },
        );
      }, BACKGROUND_CONTEXT);
      const settled = await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
      const page = await conversation.entries(
        { order: "descending" },
        20,
        undefined,
        BACKGROUND_CONTEXT,
      );
      const entry = page.items.find((item: EntryRecord) => {
        const message = item.model?.[0];
        return (
          item.kind === "pi.tool-result" &&
          message !== undefined &&
          "toolCallId" in message &&
          message.toolCallId === id
        );
      });
      const message = entry?.model?.[0];
      const content =
        message !== undefined && message.role === "toolResult"
          ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
          : "";
      return {
        status: settled.state.outcome.status,
        isError: message !== undefined && message.role === "toolResult" && message.isError === true,
        text: content,
      };
    };
    await run({ call: callOnce, audits, root });
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await workspace.close();
    await rm(base, { recursive: true, force: true });
  }
}

// NB2: a call's granted path is asked for as the run (the conversation) the call runs in, never
// the workspace the audit rows are recorded under.
test("NB2: the run a tool call is granted for is its conversation, not the workspace", () => {
  const asked: string[] = [];
  const chooser = grantPathFor((runId) => {
    asked.push(runId);
    return undefined;
  });
  // The audit identity names the workspace as the session and the tool task's conversation as the
  // run; the granted path is asked for the run.
  chooser({ workspaceId: "w1", sessionId: "w1", conversationId: "7", eventId: () => "e" });
  expect(asked).toStrictEqual(["7"]);
  // A wiring with no conversation takes no granted path: nothing is asked for.
  expect(chooser({ workspaceId: "w1", sessionId: "w1", eventId: () => "e" })).toBeUndefined();
  expect(asked).toStrictEqual(["7"]);
});

// NB2: through a real harness, the run a call is granted for is the tool task's conversation.
test("NB2: a granted call's run is the conversation the tool task runs in", async () => {
  const path = grantedPath({});
  const runs: string[] = [];
  await withGranted(
    async ({ call }) => {
      await call("read_file", { path: "a.txt" });
      expect(runs).toHaveLength(1);
      // The harness names its conversation by a decimal id; the workspace is "w1".
      expect(runs[0]).toMatch(/^[0-9]+$/u);
    },
    path.grants,
    (runId) => {
      runs.push(runId);
      return path.grants;
    },
  );
});

// C1: a call goes to the relay with the grant the issuer signed, and the model reads the machine's
// result.
test("C1: the granted path relays the call with its grant and returns the machine's result", async () => {
  const path = grantedPath({});
  await withGranted(async ({ call, audits }) => {
    const outcome = await call("read_file", { path: "a.txt" });
    expect(outcome.isError).toBe(false);
    expect(JSON.parse(outcome.text)).toMatchObject({ ok: true, content: "from the machine" });
    expect(path.relay.calls).toHaveLength(1);
    expect(path.relay.calls[0]?.grant.payload.grantId).toBe("grant-1");
    expect(path.relay.calls[0]?.call.args).toMatchObject({ path: "a.txt" });
    // The audit records the decision the machine gave, with the grant it ran under.
    const result = audits.find((event) => event.event === "tool.result");
    expect(result?.decision).toMatchObject({ outcome: "allow", grantId: "grant-1" });
    expect(result?.grantId).toBe("grant-1");
  }, path.grants);
});

// C1: the registered tool does not run the call in this process: a write the machine applied leaves
// this file as it was.
test("C1: the registered tool does not run the call that the machine ran", async () => {
  const path = grantedPath({
    relay: (call) =>
      call.toolId === "write_file"
        ? {
            decision: {
              outcome: "allow",
              policyRevision: 1,
              policyHash: "b".repeat(64),
              grantId: "grant-1",
            },
            grantId: "grant-1",
            result: {
              kind: "write",
              result: { status: "applied", operationId: "op-1", version: "sha256:y" },
            },
          }
        : ALLOW(call),
  });
  await withGranted(async ({ call, root }) => {
    const outcome = await call("write_file", {
      path: "a.txt",
      content: "changed by the machine",
      expectedVersion: "sha256:absent",
    });
    expect(outcome.isError).toBe(false);
    expect(JSON.parse(outcome.text)).toStrictEqual({
      status: "applied",
      operationId: "op-1",
      version: "sha256:y",
    });
    // The file here never received the content: the machine did the write, not this process.
    await expect(readFile(join(root, "a.txt"), "utf8")).rejects.toThrow();
  }, path.grants);
});

// C6: a refusal is the harness's refusal to the model with the machine's code in the audit, and the
// run does not fail.
test("C6: a refusal reaches the model as the harness's error and the run continues", async () => {
  const path = grantedPath({
    relay: () => ({ decision: deny("scope_exceeded", "outside the granted scope") }),
  });
  await withGranted(async ({ call, audits }) => {
    const outcome = await call("read_file", { path: "a.txt" });
    expect(outcome.status).toBe("completed");
    expect(outcome.isError).toBe(true);
    // The model reads the denial as a JSON failure value, and the run is not dropped (D005).
    expect(JSON.parse(outcome.text)).toStrictEqual({
      ok: false,
      status: "denied",
      message: "outside the granted scope",
    });
    expect(audits.find((event) => event.event === "tool.result")?.decision).toMatchObject({
      outcome: "deny",
      code: "scope_exceeded",
    });
    // A second call after a refusal is made as usual.
    const again = await call("read_file", { path: "a.txt" });
    expect(again.status).toBe("completed");
    expect(path.relay.calls).toHaveLength(2);
  }, path.grants);
});

// C8: a policy refusal is the call's denial, and nothing is relayed.
test("C8: a policy refusal is the decision, and no machine sees a call", async () => {
  const path = grantedPath({ answer: { ok: false, decision: deny("tool_disabled", "off") } });
  await withGranted(async ({ call, audits }) => {
    const outcome = await call("read_file", { path: "a.txt" });
    expect(outcome.isError).toBe(true);
    expect(path.relay.calls).toHaveLength(0);
    expect(audits.find((event) => event.event === "tool.result")?.decision).toMatchObject({
      outcome: "deny",
      code: "tool_disabled",
    });
  }, path.grants);
});
