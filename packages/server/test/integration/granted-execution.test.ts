import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as v from "valibot";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage, ToolTask } from "@earendil-works/pi-durable";
import type { EntryRecord, JsonObject } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Workspace } from "@hns/workspace";
import { isoTimestamp } from "@hns/core";
import { PolicySnapshotBodySchema } from "@hns/workspace/protocol";
import type { PolicyDecision, ToolManifest } from "@hns/core/capability";
import { openStore } from "../../../store/src/index.ts";
import { createD1Harness, type D1Harness } from "../../../store/test/integration/harness.ts";
import { WORKSPACE_TOOLS, manifestFor } from "../../../agent/src/capability.ts";
import { sessionGrantPath } from "../../../agent/src/runtime.ts";
import type { GrantSource, ToolTransport } from "../../../agent/src/runtime.ts";
import { workspaceTools } from "../../../agent/src/tools.ts";
import { runGrantedCall } from "../../../machine/src/granted.ts";
import { GrantCounter } from "../../../machine/src/capability/counter.ts";
import { resolveLimits } from "../../../machine/src/limits.ts";
import { enrolledGrantKeys } from "../../../machine/src/capability/keys.ts";
import { controlPlanePublicKey, grantSigner } from "../../src/capability/signing.ts";
import { createPolicyAudit, type AuditRow, type PolicyAudit } from "../../src/do/audit.ts";
import type { WorkspaceToolsOptions } from "../../../agent/src/tools.ts";
import { createSqliteGrantRecorder, openGrantTables } from "../../src/do/grant-store.ts";
import type { GrantRecord } from "../../src/do/grant-ledger.ts";
import type { MachineFiles } from "../../src/do/machine.ts";
import {
  createGrantPlane,
  type GrantPlane,
  type PolicySnapshot,
} from "../../src/do/session-grants.ts";
import { createToolPath, type GrantIssuer, type ToolPath } from "../../src/do/session-tools.ts";
import { createPolicyService } from "../../src/policy/service.ts";
import { openSqliteState } from "../../test/support/sqlite.ts";

/**
 * The real path of 0226: a model's tool call goes through the tool hooks to the Session object's
 * issuer, is relayed to the machine, and runs only after the machine's verifier allowed it; the
 * audit names the grant; a revoked grant is refused before a machine sees it.
 *
 * @remarks
 * Every part is the production one but the model (faux) and the machine's process: the hooks are
 * `workspaceTools({ grants })` in a real harness, the issuer is 0224's `createGrantPlane` over the
 * production recorder and the real control-plane key, the policy snapshot is a real D1 revision from
 * the production policy service, the machine is 0225's `authorizeGrantedCall` over the key a machine
 * enrolls with and a real counter directory (with `crypto.subtle`), the execution is the machine's
 * `runGrantedCall` over a real ROOT, and the audit is the object's own `policy_audit` table.
 *
 * The one indirection is the relay's wire: in production the object posts its own
 * `/rpc/conversations/<run>/tool` route (proved by the Session's unit suite); here the transport
 * calls the same path machinery in-process.
 */

/** The machine's response bounds, as a machine's agent resolves them. */
const LIMITS = resolveLimits({});

/** The seed `HNS_CONTROL_PLANE_KEY` holds; its public half is what a machine enrolls. */
const SEED = Buffer.from(new Uint8Array(32).fill(17)).toString("base64url");

const MACHINE_ID = "machine-1";
const WORKSPACE_ID = "project-1";
const RUN_ID = "run-1";

let d1: D1Harness;
let base = "";

beforeAll(async () => {
  d1 = await createD1Harness();
  base = await mkdtemp(join(tmpdir(), "hns-granted-real-"));
});

afterAll(async () => {
  await d1.dispose();
  await rm(base, { recursive: true, force: true });
});

/** The three workspace tools' manifests, as the agent builds them. */
async function manifests(): Promise<readonly ToolManifest[]> {
  return await Promise.all(WORKSPACE_TOOLS.map(async (tool) => (await manifestFor(tool)).manifest));
}

/** A machine port the granted path does not use: the path relays over `fetch`. */
function idleMachine(): MachineFiles {
  const unused = (): never => {
    throw new Error("the granted path relays over fetch, not through the machine port");
  };
  return {
    write: async () => unused(),
    read: async () => unused(),
    checkpoint: async () => unused(),
  };
}

/** One whole object: the plane, the audit, the granted path, and the machine it relays to. */
interface RealObject {
  readonly root: string;
  readonly plane: GrantPlane;
  readonly audit: PolicyAudit;
  readonly objectPath: ToolPath;
  readonly snapshot: PolicySnapshot;
  /** The path the agent's tool code is given (Phase 0's `undefined` when the path is closed). */
  readonly granted: ReturnType<typeof sessionGrantPath> | undefined;
  /** Every tool the machine was asked to run, in order. */
  readonly machineCalls: string[];
  readonly ledger: ReturnType<typeof openGrantTables>["ledger"];
  /** Record the grant the run's relay was last given, as the object's `grantOf` reads it. */
  readonly markGrantForRun: (grantId: string) => void;
  close(): void;
}

/**
 * Build one Session object over the real D1 policy, issuer, and machine verifier.
 *
 * @param options - `granted: false` keeps the granted path closed (the kill switch).
 */
async function openObject(options: { readonly granted: boolean }): Promise<RealObject> {
  await d1.reset();
  const store = await openStore({ d1: d1.db });
  const state = openSqliteState();
  try {
    const service = createPolicyService({ policy: store.policy, bashSandbox: false });
    const active = await service.ensure(WORKSPACE_ID);
    const snapshot: PolicySnapshot = {
      revision: active.revision,
      hash: active.hash,
      document: active.document,
    };
    const tables = openGrantTables(state.state.storage);
    const signer = await grantSigner({ seed: SEED });
    if (!signer.ok) throw new Error("the seed produced no signer: " + signer.code);
    const plane = createGrantPlane({
      signer: signer.signer,
      recorder: createSqliteGrantRecorder({
        ledger: tables.ledger,
        audit: tables.audit,
        transaction: (run) => state.state.storage.transaction(run),
        eventId: () => crypto.randomUUID(),
      }),
      workspaceId: WORKSPACE_ID,
      sessionId: WORKSPACE_ID,
      now: () => Date.now(),
      eventId: () => crypto.randomUUID(),
    });
    const audit = createPolicyAudit(state.state.storage);
    const issuer: GrantIssuer = {
      issue: async (input) => {
        const issue = await plane.one({
          request: input.request,
          snapshot: input.snapshot,
          requestedBy: { kind: "agent", id: input.agentId, runId: input.runId },
          manifests: input.manifests,
        });
        return issue.ok
          ? { ok: true, grant: issue.grant }
          : { ok: false, decision: issue.decision };
      },
    };
    let auditId = 0;
    // The run's last grant as the ledger holds it, live or revoked. A revoked one gets no
    // replacement: the run ended.
    let lastForRun: string | undefined;
    const objectPath = createToolPath({
      workspaceId: WORKSPACE_ID,
      sessionId: WORKSPACE_ID,
      issuer: options.granted ? issuer : undefined,
      audit,
      machine: idleMachine(),
      controlPlaneKey: SEED,
      machineId: MACHINE_ID,
      manifests,
      revoked: async (grantId) => (await tables.ledger.get(grantId))?.revokedAt !== undefined,
      grantOf: async (runId): Promise<GrantRecord | undefined> => {
        const live = (await tables.ledger.boundTo(runId)).at(0);
        const id = live?.grantId ?? lastForRun;
        return id === undefined ? undefined : await tables.ledger.get(id);
      },
      now: () => Date.now(),
      eventId: () => "audit:" + String((auditId += 1)),
    });
    // The machine: the key it enrolled with, a counter directory of its own, and a real ROOT.
    const raw = await controlPlanePublicKey(SEED);
    if (raw === undefined) throw new Error("the seed has no public half");
    const keys = enrolledGrantKeys({ publicKeys: async () => [raw] });
    const counter = new GrantCounter(join(base, crypto.randomUUID(), "grants"));
    const root = join(base, crypto.randomUUID(), "root");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "a.txt"), "v1", "utf8");
    const machineCalls: string[] = [];
    const transport: ToolTransport | undefined = options.granted
      ? {
          async call(input) {
            machineCalls.push(input.call.toolId);
            const outcome = await runGrantedCall({
              request: {
                op: "tool",
                authorization: input.grant,
                call: input.call,
                manifest: input.contract.manifest,
                activePolicy: { revision: snapshot.revision, hash: snapshot.hash },
                // What this call's output may reach, as the agent's request declares it; the
                // grant's byte budget covers a turn of them.
                bytes: input.bytes,
              },
              keys,
              counter,
              machineId: MACHINE_ID,
              now: new Date(),
              root,
              identity: undefined,
              signal: new AbortController().signal,
              // The exec is never reached in this test: the policy enables no bash.
              limits: LIMITS,
              exec: { ready: false, reason: "no shell in this test" },
            });
            if (outcome.kind === "denied") return { decision: outcome.decision };
            const read = v.parse(ReadOpResultSchema, outcome.result);
            return {
              decision: outcome.decision,
              grantId: outcome.grantId,
              // The machine's operation result, as its wire type: a read is base64 content.
              result: {
                kind: "read",
                content: read.content,
                version: read.version,
                size: read.size,
              },
            };
          },
          async closeRun() {
            // The run's end is the test's own revocation.
          },
        }
      : undefined;
    const source: GrantSource | undefined = options.granted
      ? {
          async issue(request) {
            const issued = await issuer.issue({
              snapshot,
              request: {
                workspaceId: WORKSPACE_ID,
                sessionId: WORKSPACE_ID,
                machineId: MACHINE_ID,
                toolId: request.toolId,
                toolVersion: request.toolVersion,
                manifestHash: request.manifestHash,
                maxBytes: request.maxBytes ?? 0,
              },
              runId: RUN_ID,
              agentId: WORKSPACE_ID,
              manifests: await manifests(),
            });
            lastForRun = issued.ok ? issued.grant.payload.grantId : lastForRun;
            return issued;
          },
        }
      : undefined;
    const granted =
      source === undefined || transport === undefined
        ? undefined
        : sessionGrantPath({ source, transport });
    return {
      root,
      plane,
      audit,
      objectPath,
      snapshot,
      granted,
      machineCalls,
      ledger: tables.ledger,
      markGrantForRun: (grantId: string) => {
        lastForRun = grantId;
      },
      close: () => {
        state.close();
      },
    };
  } finally {
    await store.close();
  }
}

/** The machine's read result, as its wire type. */
const ReadOpResultSchema = v.object({
  path: v.string(),
  size: v.number(),
  version: v.string(),
  content: v.string(),
});

/** What one model-issued call settled as, and the text the model reads. */
interface Outcome {
  readonly status: string;
  readonly isError: boolean;
  readonly text: string;
}

/** Run model calls through a real harness; the machine and the issuer are the object's. */
async function withHarness(
  object: RealObject,
  run: (call: (name: string, args: JsonObject) => Promise<Outcome>) => Promise<void>,
): Promise<void> {
  const env = new NodeExecutionEnv({ cwd: object.root });
  const workspace = await Workspace.open({
    env,
    root: object.root,
    journalPath: join(base, crypto.randomUUID(), "journal.json"),
    context: BACKGROUND_CONTEXT,
    rooted: false,
  });
  const registry = createRegistry();
  const options: WorkspaceToolsOptions = {
    workspace,
    shell: { kind: "disabled", env, reason: "no exec in this test" },
    audit: async (event) => {
      await object.audit.append(event);
    },
    auditIdentity: {
      workspaceId: WORKSPACE_ID,
      sessionId: RUN_ID,
      eventId: () => crypto.randomUUID(),
    },
  };
  const granted = object.granted;
  const toolsOptions: WorkspaceToolsOptions =
    granted === undefined ? options : { ...options, grants: () => granted };
  registry.install(workspaceTools(toolsOptions));
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
    const call = async (name: string, args: JsonObject): Promise<Outcome> => {
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
          ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
          : "";
      return {
        status: settled.state.outcome.status,
        isError: message !== undefined && message.role === "toolResult" && message.isError === true,
        text: content,
      };
    };
    await run(call);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await workspace.close();
  }
}

/** The audit's rows, oldest first, as the object stores them. */
async function auditRows(object: RealObject) {
  return await object.audit.list(200);
}

/** One audit row's grant, as a stored row holds it. */
const StoredGrantSchema = v.object({ grantId: v.nullable(v.string()) });

/** A row's grant, or null for a row that names none. */
function rowGrantId(row: AuditRow | undefined): string | null {
  return row === undefined ? null : v.parse(StoredGrantSchema, row).grantId;
}

/** The decision of the newest `tool.result` row: the contract puts the decision on the result only. */
function lastDecision(rows: readonly AuditRow[]): PolicyDecision | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row !== undefined && row.decision !== null) return row.decision;
  }
  return undefined;
}

// C1 + C7: the model's call is granted by the real issuer, verified by the machine's own verifier,
// run on the machine, and audited with its grant.
test("C1: a model call reaches the machine through a real grant and is audited with it", async () => {
  const object = await openObject({ granted: true });
  try {
    expect(object.granted).toBeDefined();
    await withHarness(object, async (call) => {
      const outcome = await call("read_file", { path: "a.txt" });
      if (outcome.isError) throw new Error("the call failed: " + outcome.text);
      expect(JSON.parse(outcome.text)).toMatchObject({ ok: true, content: "v1", truncated: false });
      // The machine was asked once, and its own verifier allowed the grant the object issued.
      expect(object.machineCalls).toStrictEqual(["read_file"]);
      const rows = await auditRows(object);
      expect(rows.map((row) => row.event)).toStrictEqual(["tool.call", "tool.result"]);
      expect(lastDecision(rows)).toMatchObject({ outcome: "allow", policyRevision: 1 });
      // The grant the audit names is the one the ledger recorded, bound to this run.
      const grantId = rowGrantId(rows.at(-1));
      expect(grantId).not.toBeNull();
      const record = await object.ledger.get(grantId ?? "");
      expect(record?.requestedBy).toMatchObject({ kind: "agent", runId: RUN_ID });
    });
  } finally {
    object.close();
  }
});

// C2: the agent's cache makes two calls one grant: the ledger holds one row, and the machine is
// given the same grant both times.
test("C2: two calls of one tool are one grant", async () => {
  const object = await openObject({ granted: true });
  try {
    await withHarness(object, async (call) => {
      const first = await call("read_file", { path: "a.txt" });
      if (first.isError) throw new Error("the first call failed: " + first.text);
      const second = await call("read_file", { path: "a.txt" });
      // The second call spends the same grant's budget; a refusal here means it saw another one.
      if (second.isError) {
        const rows = await auditRows(object);
        const ids = rows.filter((row) => rowGrantId(row) !== null).map(rowGrantId);
        throw new Error(
          "the second call failed: " + second.text + " grants: " + JSON.stringify(ids),
        );
      }
      const bound = await object.ledger.boundTo(RUN_ID);
      expect(bound).toHaveLength(1);
      expect(object.machineCalls).toStrictEqual(["read_file", "read_file"]);
      // The audit names the grant the ledger holds for the run: one capability served both calls.
      const named = (await auditRows(object)).filter((row) => rowGrantId(row) !== null);
      const ids = [...new Set(named.map(rowGrantId))];
      expect(ids).toStrictEqual([bound[0]?.grantId]);
    });
  } finally {
    object.close();
  }
});

// C9: once the run's grant is revoked, the object refuses it before a machine sees it.
test("C9: a revoked grant is refused before the machine, as grant_revoked", async () => {
  const object = await openObject({ granted: true });
  try {
    await withHarness(object, async (call) => {
      const first = await call("read_file", { path: "a.txt" });
      if (first.isError) throw new Error("the call failed: " + first.text);
      const manifestsOfTool = await manifests();
      const readManifest = manifestsOfTool.find((manifest) => manifest.toolId === "read_file");
      if (readManifest === undefined) throw new Error("no read_file manifest");
      // The grant the run held (the ledger's live row), revoked as the run's end revokes it.
      const held = (await object.ledger.boundTo(RUN_ID)).at(0);
      if (held === undefined) throw new Error("the run held no grant");
      const grantId = held.grantId;
      object.markGrantForRun(grantId);
      expect(await object.ledger.revoke(grantId, isoTimestamp(new Date().toISOString()))).toBe(
        true,
      );
      // A turn is admitted under the snapshot the Worker sends; the object then refuses the run's
      // revoked grant before any machine is asked.
      // The snapshot as the body carries it: the same members, and the object's parser checks it
      // again (its hash is recomputed) before it is kept.
      expect(
        await object.objectPath.state.admitTurn(v.parse(PolicySnapshotBodySchema, object.snapshot)),
      ).toMatchObject({ ok: true });
      const relayed = await object.objectPath.relay(RUN_ID, {
        call: {
          v: 1,
          callId: "tool:9:after-revoke",
          toolId: "read_file",
          toolVersion: readManifest.version,
          args: { path: "a.txt" },
        },
        manifest: readManifest,
        bytes: 4096,
      });
      if (!relayed.ok) {
        throw new Error(
          "the object should answer a decision: " + relayed.code + " " + relayed.message,
        );
      }
      expect(relayed.answer.decision).toMatchObject({ outcome: "deny", code: "grant_revoked" });
      expect(lastDecision(await auditRows(object))).toMatchObject({
        outcome: "deny",
        code: "grant_revoked",
      });
      // The machine was asked for the one call before the revocation and for nothing after it.
      expect(object.machineCalls).toStrictEqual(["read_file"]);
    });
  } finally {
    object.close();
  }
});

// The kill switch: a Session whose granted path is closed keeps the Phase 0 tools and issues nothing.
test("a closed granted path runs the Phase 0 tools and issues no grant", async () => {
  const object = await openObject({ granted: false });
  try {
    expect(object.granted).toBeUndefined();
    await withHarness(object, async (call) => {
      const outcome = await call("read_file", { path: "a.txt" });
      if (outcome.isError) throw new Error("the call failed: " + outcome.text);
      expect(JSON.parse(outcome.text)).toMatchObject({ ok: true, content: "v1" });
      expect(object.machineCalls).toHaveLength(0);
      const rows = await auditRows(object);
      // Phase 0's rows carry no grant: nothing was issued, and the decision is the agent's own.
      expect(rows.map((row) => rowGrantId(row))).toStrictEqual([null, null]);
      expect(lastDecision(rows)).toMatchObject({ outcome: "allow", policyRevision: 0 });
    });
  } finally {
    object.close();
  }
});
