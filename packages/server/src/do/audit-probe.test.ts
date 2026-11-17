import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { workspaceTools, type ShellAccess } from "@hns/agent";
import { openSession, type AgentSession } from "@hns/agent/session";
import { Workspace } from "@hns/workspace";
import { createNoExecEnv, createSandboxEnv, detectSandbox } from "@hns/workspace/sandbox";
import { expect, test } from "vitest";
import { openSqliteState } from "../../test/support/sqlite.ts";
import { auditEventIds, auditSink, createPolicyAudit, storedEvent } from "./audit.ts";
import { handleSessionRpc } from "./session-rpc.ts";

/**
 * A probe: the whole production path with only the model faked.
 *
 * @remarks
 * A faux model asks for a `read_file`, pi-durable's own `ToolTask` runs the agent's hooks, the hooks
 * append to the object's SQLite through the sink the Session DO hands them, and the read then goes
 * through the RPC face. Nothing here is a mock of the audit: the table, the transaction, the hashing,
 * and the route are production code. What it proves is what the tests cannot: the wiring between
 * `openDurableSession`, `openSession`, the workspace extension, and `handleSessionRpc`.
 */

test("probe: a faux turn's tool call is chained into the object's audit and read back by the RPC", async () => {
  const base = await mkdtemp(join(tmpdir(), "hns-audit-probe-"));
  const root = join(base, "root");
  await mkdir(root);
  const env = new NodeExecutionEnv({ cwd: root });
  // No exec is needed for this probe: the tool it exercises is `read_file`. The host's own probe
  // decides what the shell would be here; a host without bwrap gets a disabled one as the agent
  // would, and either way `read_file` runs.
  const sandbox = await detectSandbox();
  const shell: ShellAccess = sandbox.available
    ? { kind: "sandboxed", env: createSandboxEnv(env, { root, bwrap: sandbox.bwrap }) }
    : { kind: "disabled", env: createNoExecEnv(env, sandbox), reason: sandbox.reason };
  // The tools the agent registers; this probe exercises `read_file`, which needs a workspace root.
  const workspace = await Workspace.open({
    env,
    root,
    journalPath: join(base, "journal.json"),
    context: ctx,
    rooted: false,
  });
  await workspace.write({
    path: "a.txt",
    content: "v1",
    expectedVersion: "absent",
    operationId: "seed",
  });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const object = openSqliteState();
  const audit = createPolicyAudit(object.state.storage);
  const ids = auditEventIds("probe");
  const registry = createRegistry();
  registry.install(workspaceTools({ workspace, shell }));
  // The storage the DO itself opens, beside the audit table in the same object SQLite.
  const storage = await openDurableObjectSqliteStorage(object.state.storage, {
    prefix: "hns_session",
  });
  const session: AgentSession = await openSession({
    storage,
    models,
    registry,
    model: { provider: "faux", modelId: "faux-1" },
    context: ctx,
    // The one line the Session DO adds: the object's sink and the identity it records under.
    onAudit: auditSink(audit),
    auditIdentity: { workspaceId: "ws", sessionId: "ss", eventId: () => ids.next() },
  });
  try {
    const conversation = await session.createConversation({ title: "probe", workspaceRoot: root });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_file", { path: "a.txt" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const turn = await session.send(conversation.id, "read the file");
    expect(turn.settlement.status).toBe("done");

    // The chain the object holds: tool.call then tool.result, each linking to the row before it.
    const verdict = await audit.verify();
    expect(verdict).toStrictEqual({ ok: true, rows: 2 });
    const rows = await audit.list();
    expect(rows.map((row) => row.event)).toStrictEqual(["tool.call", "tool.result"]);
    const [call, result] = rows;
    expect(call?.prevHash).toBeNull();
    expect(result?.prevHash).toBe(call?.hash);
    expect(call?.callHash).toHaveLength(64);
    expect(result?.decision).toMatchObject({ outcome: "allow" });
    // Read back as the contract's event: a call that ran names its hashes.
    expect(storedEvent(call ?? rows[0]!).callHash).toBeDefined();

    // The RPC face answers the same rows, ascending, through the Session's dependencies.
    const response = await handleSessionRpc(
      new Request("https://session/rpc/policy/audit?limit=10"),
      session,
      { audit },
    );
    expect(response.status).toBe(200);
    // SAFETY: the internal route's body is this module's own JSON, whose shape it wrote.
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly rows: readonly {
        readonly seq: number;
        readonly event: string;
        readonly hash: string;
      }[];
    };
    expect(body.ok).toBe(true);
    // What the object stores is what the RPC answers, and no file content is in it.
    const stored = await audit.list();
    expect(stored.map((row) => row.hash)).toStrictEqual(body.rows.map((row) => row.hash));
    expect(body.rows.map((row) => row.event)).toStrictEqual(["tool.call", "tool.result"]);
    expect(body.rows.map((row) => row.hash)).toStrictEqual([call?.hash, result?.hash]);
    expect(JSON.stringify(body)).not.toContain("v1");
  } finally {
    await session.close();
    await workspace.close();
    object.close();
    await rm(base, { recursive: true, force: true });
  }
});
