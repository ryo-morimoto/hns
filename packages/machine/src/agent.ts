import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { realpath, stat } from "node:fs/promises";
import * as v from "valibot";
import { MAX_CHECKPOINT_PACK_BYTES, MACHINE_RPC_PATH } from "@hns/core";
import type { CheckpointPackUploadResult, JsonValue } from "@hns/core";
import { Denied, FileFailure } from "@hns/workspace";
import type { RootIdentity } from "@hns/workspace";
import { detectSandbox } from "@hns/workspace/sandbox";
import type { SandboxEgress, SandboxReport } from "@hns/workspace/sandbox";
import { createMachineExec, machineHostEnv } from "./exec.ts";
import type { MachineExec } from "./exec.ts";
import { ConnectionGate } from "./connection.ts";
import { normalizeRelative } from "./containment.ts";
import { InFlight, resolveLimits } from "./limits.ts";
import type { Limits } from "./limits.ts";
import {
  machineEntry,
  redactingSink,
  requestIdOf,
  writeMachineLog,
  type MachineLogSink,
} from "./log.ts";
import type { GrantCounter } from "./capability/counter.ts";
import { enrolledGrantKeys } from "./capability/keys.ts";
import type { GrantKeys } from "./capability/keys.ts";
import { runGrantedCall } from "./granted.ts";
import { runOperation } from "./operations.ts";
import { MachineRefusal, refusalStatus } from "./refusal.ts";
import { RequestVerifier } from "./signature.ts";
import type { ControlPlaneKeys } from "./control-plane.ts";
import {
  MACHINE_PACK_CONTENT_TYPE,
  PACK_RESPONSE_OP,
  checkpointPackRunId,
  parseOperation,
  parseSignedHeaders,
} from "./wire.ts";
import type {
  GrantedOperation,
  GrantedResult,
  OperationName,
  RefusalBody,
  RpcRequest,
  SuccessBody,
} from "./wire.ts";

/** The only address the agent ever listens on: cloudflared connects from here. */
const HOST = "127.0.0.1";

/** How to start an agent. */
export interface MachineAgentOptions {
  /** The directory the agent may serve; canonicalized once at start. */
  readonly root: string;
  /** The machine this agent runs for, as its Machine record names it. */
  readonly machineId: string;
  /** Where the enrolled control-plane public keys come from. */
  readonly controlPlane: ControlPlaneKeys;
  /** The local port; 0 asks the operating system for a free one. */
  readonly port: number;
  /** The clock; tests pass a fixed one. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** How far from the clock a timestamp may be. Defaults to 60 seconds. */
  readonly windowMs?: number | undefined;
  /** The bounds; the missing ones keep their defaults. */
  readonly limits?: Partial<Limits> | undefined;
  /**
   * Where one JSON line per request goes; defaults to stderr.
   *
   * @remarks
   * The line is the same shape the server writes. The request id comes from the inbound
   * `x-request-id` header, which is not signed and never used for authentication.
   */
  readonly onLog?: MachineLogSink | undefined;
  /**
   * Where an accepted checkpoint pack goes.
   *
   * @remarks
   * The agent makes checkpoints and accepts their packs, and this receives the bytes once the
   * request is authenticated. Unset means the machine has no destination for a pack yet (the
   * Worker's half is 0245), so every upload is refused with `internal` rather than accepted
   * into nothing. The sink is the machine's only outbound seam for a pack and never sees a
   * secret: the bytes are the repository's content, not a token.
   */
  readonly onCheckpointPack?: ((upload: CheckpointPackUpload) => Promise<void>) | undefined;
  /**
   * The sandbox probe's verdict; defaults to probing the host with `detectSandbox()`.
   *
   * @remarks
   * The verdict decides whether `exec` runs or refuses (D095). A test passes one to prove the
   * refusal without needing a host that lacks bubblewrap; a deployment leaves it unset, so the
   * real probe runs once at start and its reason reaches the health answer.
   */
  readonly sandbox?: SandboxReport | undefined;
  /**
   * The account whose home the sandbox hides; defaults to `os.homedir()`.
   *
   * @remarks
   * The hide list is fixed, but the account is not: a test points it at a temporary home, and a
   * deployment keeps the operator's.
   */
  readonly home?: string | undefined;
  /** The project's egress; unset means `deny` (D095). */
  readonly egress?: SandboxEgress | undefined;
  /**
   * The grants this machine will verify, and where its counters live; unset means no granted call
   * can run (fail closed).
   *
   * @remarks
   * Without it every `op: "tool"` is refused before anything is verified or run: a machine that has
   * no key to check a grant with, or no counter to spend it from, cannot decide a granted call, and
   * "cannot tell" is never "allow". The relay in front of the machine never presents a granted call
   * to a machine that was not configured for one.
   */
  readonly grants?: MachineGrants | undefined;
}

/**
 * What a machine needs to decide a granted call: the keys it verifies with, and the budget it spends.
 *
 * @remarks
 * `keys` is the lookup over the enrolled control-plane keys ({@link ./capability/keys.ts}); `counter`
 * is the machine's own per-grant spend under `~/.config/hns/grants`, which the agent's shell cannot
 * read (0194). `enrolled` is the enrolment the keys are built from, used when `keys` is not given.
 */
interface MachineGrants {
  readonly keys?: GrantKeys | undefined;
  readonly enrolled?: ControlPlaneKeys | undefined;
  readonly counter: GrantCounter;
}

/** A running agent. */
export interface MachineAgent {
  /** `http://127.0.0.1:<port>`, the address cloudflared proxies to. */
  readonly origin: string;
  /**
   * Whether this agent runs commands at all, and why not when it does not.
   *
   * @remarks
   * `exec: "enabled"` means the probe passed and `op: "exec"` runs inside bubblewrap.
   * `exec: "disabled"` means every exec is refused with `forbidden`; `reason` says what the
   * probe saw. A caller that needs a shell reads this at start instead of discovering it later.
   */
  readonly shell: { readonly exec: "enabled" | "disabled"; readonly reason: string };
  /** The address the listener is bound to; always `127.0.0.1`. */
  readonly address: string;
  readonly port: number;
  /** Requests holding a concurrency slot now. */
  readonly inFlight: number;
  /** Stop accepting and drop open connections. */
  close(): Promise<void>;
}

/** What every request of one agent shares. */
interface AgentContext {
  readonly root: string;
  readonly identity: RootIdentity;
  readonly limits: Limits;
  readonly verifier: RequestVerifier;
  readonly gate: ConnectionGate;
  readonly inFlight: InFlight;
  readonly onLog: MachineLogSink;
  /** Where an accepted checkpoint pack goes; set from {@link MachineAgentOptions.onCheckpointPack}. */
  readonly checkpointPacks: CheckpointPackSink | undefined;
  /** The sandboxed exec, or the fail-closed state that refuses every command (D095). */
  readonly exec: MachineExec;
  /** The keys and the counter a granted call is decided with; absent means none can run. */
  readonly grants: MachineGrants | undefined;
  /** This machine's id, the one a grant must name. */
  readonly machineId: string;
  /** The clock a grant's expiry is checked against. */
  readonly now: () => number;
}

/**
 * The bytes one checkpoint pack upload delivered.
 *
 * @remarks
 * The agent forwards the bytes and what it learned about the route; it does not write them.
 * `receivedBytes` equals `bytes.byteLength`, which is what the upload answers with.
 */
export interface CheckpointPackUpload {
  readonly runId: string;
  readonly bytes: Uint8Array;
}

/**
 * Where the agent hands a checkpoint pack.
 *
 * @remarks
 * The pack was authenticated before this is called: its signature covers the pack route and the
 * pack's own bytes. The receiver decides where the bytes go and what the answer says; a
 * receiver that fails is answered as `internal`, never as a success.
 */
export type CheckpointPackSink = (upload: CheckpointPackUpload) => Promise<void>;

/** The address Node reports after a successful listen. */
const BoundAddressSchema: v.GenericSchema<unknown, AddressInfo> = v.object({
  address: v.string(),
  family: v.string(),
  port: v.number(),
});

/**
 * The refusal a passed deadline answers with.
 *
 * @returns The same refusal the abort reason carries, when one was given.
 */
function deadlineRefusal(): MachineRefusal {
  return new MachineRefusal("deadline_exceeded", "the request passed its deadline");
}

/**
 * Start the machine agent.
 *
 * @param options - The root, the machine identity, the key registry, and the bounds.
 * @returns A running agent bound to `127.0.0.1`; the port is the one it got.
 * @throws {Error} When the root cannot be canonicalized, is not a directory, the
 * port cannot be bound, or a bound is not a positive integer.
 *
 * @remarks
 * The listener is loopback-only, so the process opens no inbound port: the only
 * way in is the outbound cloudflared tunnel. A request is read only after a
 * concurrency slot is taken, its body read and the operation share one deadline,
 * and the operation is awaited to its settlement, so a slow or endless body or
 * file cannot leave work running behind a released slot.
 */
export async function startMachineAgent(options: MachineAgentOptions): Promise<MachineAgent> {
  const limits = resolveLimits(options.limits);
  const canonical = await canonicalRoot(options.root);
  const sandbox = options.sandbox ?? (await detectSandbox());
  // The project is the ROOT itself; the sandbox mounts a fresh ROOT so the root's siblings are
  // not in the shell, and binds this project writable inside it.
  const exec = await createMachineExec(machineHostEnv(canonical.path), {
    sandbox,
    root: canonical.path,
    projectRoot: canonical.path,
    home: options.home,
    egress: options.egress,
  });
  const context: AgentContext = {
    root: canonical.path,
    identity: canonical.identity,
    limits,
    verifier: new RequestVerifier({
      machineId: options.machineId,
      controlPlane: options.controlPlane,
      now: options.now,
      windowMs: options.windowMs,
    }),
    gate: new ConnectionGate(),
    inFlight: new InFlight(limits.maxConcurrency),
    onLog: options.onLog ?? writeMachineLog,
    checkpointPacks: options.onCheckpointPack,
    exec,
    grants: options.grants,
    machineId: options.machineId,
    now: options.now ?? Date.now,
  };
  const server = createServer();
  server.on("request", (request: IncomingMessage, response: ServerResponse): void => {
    void handleRequest(request, response, context).catch(() => {
      if (response.headersSent) response.destroy();
      else sendRefusal(response, new MachineRefusal("internal", "internal error"));
    });
  });
  await listen(server, options.port);
  const address = v.safeParse(BoundAddressSchema, server.address());
  if (!address.success) {
    server.close();
    throw new Error("the machine agent did not obtain a TCP address");
  }
  return {
    origin: `http://${HOST}:${address.output.port}`,
    address: address.output.address,
    port: address.output.port,
    shell: exec.ready ? { exec: "enabled", reason: "" } : { exec: "disabled", reason: exec.reason },
    get inFlight(): number {
      return context.inFlight.count;
    },
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    },
  };
}

/**
 * Resolve the root once and refuse an unusable one before any request runs.
 *
 * @param root - The configured root, possibly a symbolic link.
 * @returns The canonical directory the agent serves and the dev / ino it had at
 * start, so a replaced root fails closed on a later write.
 * @throws {Error} When the root cannot be resolved or is not a directory.
 */
async function canonicalRoot(
  root: string,
): Promise<{ readonly path: string; readonly identity: RootIdentity }> {
  const canonical = await realpath(root).catch((error: Error) => {
    throw new Error(`the machine root cannot be resolved: ${error.message}`);
  });
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error("the machine root is not a directory");
  return { path: canonical, identity: { dev: info.dev, ino: info.ino } };
}

/**
 * Bind the listener and resolve once it is accepting.
 *
 * @param server - The server to start.
 * @param port - The local port; 0 asks the operating system.
 * @throws {Error} When the port cannot be bound.
 */
function listen(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}

/**
 * Serve one request: take a slot, read an authentic body, run one operation.
 *
 * @param request - The incoming request.
 * @param response - The response to write.
 * @param context - The root, bounds, verifier, and gate.
 *
 * @remarks
 * The order is deliberate: the method and route are answered first, a slot is
 * taken next, and every later step can refuse. Authentication happens before the
 * body is parsed, and the connection seq is checked after the signature so a
 * forged seq cannot evict the current connection. The body read and the
 * verification race the deadline because neither can be stopped once started;
 * the operation itself is awaited with the deadline signal, so its slot is
 * returned only after it settles.
 */
async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: AgentContext,
): Promise<void> {
  const started = Date.now();
  let fsPath = MACHINE_RPC_PATH;
  let op: OperationName | undefined;
  // A mirror's token is redacted from this request's log line even if a later field ever carried
  // it; the guard is set before the body is parsed so no failure path can log ahead of it.
  let mirrorToken: string | undefined;
  // A granted call carries a signed grant, which is a capability: the same guard redacts it from the
  // request's log line once it is parsed, and the answer never carries it.
  let grantSignature: string | undefined;
  if (request.method !== "POST") {
    sendRefusal(response, new MachineRefusal("method_not_allowed", "the agent answers POST only"), {
      allow: "POST",
    });
    logRequest(request, response, context, started, fsPath, op);
    return;
  }
  // The route is read with any query string removed: the signature covers the whole path.
  const packRunId = checkpointPackRunId(pathWithoutQuery(request.url));
  if (request.url !== MACHINE_RPC_PATH && packRunId === undefined) {
    sendRefusal(
      response,
      new MachineRefusal("not_found", "the agent answers /rpc and a checkpoint's pack route"),
    );
    logRequest(request, response, context, started, fsPath, op);
    return;
  }
  if (!context.inFlight.enter()) {
    sendRefusal(response, new MachineRefusal("busy", "too many requests are in flight"));
    logRequest(request, response, context, started, fsPath, op);
    return;
  }
  if (packRunId !== undefined) {
    await servePackUpload(request, response, context, packRunId, started, fsPath);
    return;
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(deadlineRefusal()), context.limits.timeoutMs);
  const expired = deadlineExceeded(deadline.signal);
  try {
    const body = await Promise.race([readBody(request, context.limits.maxRequestBytes), expired]);
    const headers = parseSignedHeaders(request.headers);
    await Promise.race([
      context.verifier.verify({
        method: request.method ?? "POST",
        path: request.url ?? MACHINE_RPC_PATH,
        headers,
        body,
      }),
      expired,
    ]);
    const admission = context.gate.admit(headers.connection, Number(headers.seq));
    if (admission.kind === "stale") {
      throw new MachineRefusal(
        "stale_connection",
        `a newer connection (seq ${admission.floor}) is current`,
      );
    }
    const operation = parseOperation(body);
    op = operation.op;
    if (operation.op === "mirror") mirrorToken = operation.token;
    if (operation.op === "tool") {
      grantSignature = operation.authorization.signature;
      // A granted call's answer is a decision, never a JSON refusal: the caller records it whether it
      // allowed or refused the call, so a refusal is written as a 200 with the denial in it.
      const answer = await serveGrantedCall(operation, context, deadline.signal);
      sendJson(response, { ok: true, op, result: grantedAnswerJson(answer) }, context.limits);
      return;
    }
    fsPath = logPathOf(operation);
    const result = await runOperation(
      operation,
      context.root,
      context.limits,
      deadline.signal,
      context.identity,
      context.exec,
    );
    // SAFETY: every OperationResult member is a closed object of strings, numbers, and booleans,
    // which is what JsonValue is; the operations build them and no field is a Uint8Array.
    sendJson(response, { ok: true, op, result: result as JsonValue }, context.limits);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    sendRefusal(response, asRefusal(error));
  } finally {
    clearTimeout(timer);
    context.inFlight.leave();
    logRequest(
      request,
      response,
      mirrorToken === undefined && grantSignature === undefined
        ? context
        : { ...context, onLog: redactingSink(context.onLog, [mirrorToken, grantSignature]) },
      started,
      fsPath,
      op,
    );
  }
}

/**
 * Decide one granted call, and run it only when the machine's verifier allowed it.
 *
 * @param operation - The relayed grant, call, manifest, and active policy.
 * @param context - The machine's keys, counter, ROOT, bounds, and sandbox.
 * @param signal - The request's deadline.
 * @returns The decision, with the operation's result for an allow.
 * @throws {MachineRefusal} `forbidden` when the machine was not configured to verify grants (fail
 * closed), and whatever the operation refuses with once it is allowed.
 *
 * @remarks
 * The active policy the request carries is the control channel's promise, and it is **required**: a
 * machine that was told no revision has nothing to record an allow against, and
 * `authorizeGrantedCall` refuses it (`policy_denied`). Nothing here caches a grant, a key, or a
 * decision: every granted call is verified, spent, and run on its own request.
 */
async function serveGrantedCall(
  operation: GrantedOperation,
  context: AgentContext,
  signal: AbortSignal,
): Promise<GrantedResult> {
  const grants = context.grants;
  if (grants === undefined) {
    throw new MachineRefusal(
      "forbidden",
      "this machine is not configured to verify grants, so no granted call runs",
    );
  }
  const keys =
    grants.keys ?? (grants.enrolled === undefined ? undefined : enrolledGrantKeys(grants.enrolled));
  if (keys === undefined) {
    throw new MachineRefusal(
      "forbidden",
      "this machine has no control-plane key to verify a grant",
    );
  }
  const outcome = await runGrantedCall({
    request: operation,
    keys,
    counter: grants.counter,
    machineId: context.machineId,
    now: new Date(context.now()),
    root: context.root,
    identity: context.identity,
    signal,
    limits: context.limits,
    exec: context.exec,
  });
  return outcome.kind === "denied"
    ? { decision: outcome.decision }
    : { decision: outcome.decision, grantId: outcome.grantId, result: outcome.result };
}

/**
 * The granted call's answer as JSON, member by member.
 *
 * @param answer - The decision, and for an allow the grant id and the operation's result.
 * @returns The answer on the wire; the decision is the contract's own members, never the object it
 * was parsed into, and the result is the operation's JSON.
 *
 * @remarks
 * Built here rather than cast: a JSON body's members are what the relay parses, and a value whose
 * shape only the cast promised would be a decision the relay reads wrongly.
 */
function grantedAnswerJson(answer: GrantedResult): JsonValue {
  switch (answer.decision.outcome) {
    case "deny": {
      const decision = answer.decision;
      const denial: JsonValue = {
        outcome: "deny",
        code: decision.code,
        message: decision.message,
      };
      if (decision.policyRevision !== undefined) {
        denial["policyRevision"] = decision.policyRevision;
      }
      if (decision.policyHash !== undefined) denial["policyHash"] = decision.policyHash;
      return { decision: denial };
    }
    case "allow": {
      const decision = answer.decision;
      const allow: JsonValue = {
        outcome: "allow",
        policyRevision: decision.policyRevision,
        policyHash: decision.policyHash,
      };
      if (decision.grantId !== undefined) allow["grantId"] = decision.grantId;
      return {
        decision: allow,
        grantId: answer.grantId ?? "",
        // SAFETY: every OperationResult member is a closed object of strings, numbers, and booleans,
        // which is what JsonValue is; the operations build them and no field is a Uint8Array.
        result: answer.result as JsonValue,
      };
    }
  }
}

/** A request target without its query string, as the route reads it. */
function pathWithoutQuery(url: string | undefined): string {
  if (url === undefined) return "";
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

/**
 * Serve one signed checkpoint pack upload.
 *
 * @param request - The incoming request, already holding a concurrency slot.
 * @param response - The response to write.
 * @param context - The root, bounds, verifier, and pack sink.
 * @param runId - The Run the route names.
 * @param started - Epoch milliseconds before the request was read.
 * @param fsPath - The request path as the log line reports it.
 *
 * @remarks
 * The order refuses as much as possible before a byte of the body is kept. The media type and
 * the declared length are read first: a length over {@link MAX_CHECKPOINT_PACK_BYTES} is
 * answered `too_large` without reading the body at all, so nothing partial is ever stored and a
 * client that keeps sending is cut off by the connection closing. The body is read to its
 * declared length under the pack deadline, the signature is verified over the bytes that
 * arrived, and only then does the sink see them.
 *
 * The signature covers the method, the pack route, and the sha256 of the body
 * ({@link signatureMessage}). It does **not** cover `content-type` or `content-length`: those are
 * checked here before the body is read, and the receiver re-hashes the bytes before it stores
 * them (0245), so a header changed in transit cannot make a different or short body pass for
 * the signed one.
 */
async function servePackUpload(
  request: IncomingMessage,
  response: ServerResponse,
  context: AgentContext,
  runId: string,
  started: number,
  fsPath: string,
): Promise<void> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(deadlineRefusal()),
    context.limits.packUploadTimeoutMs,
  );
  const expired = deadlineExceeded(deadline.signal);
  try {
    const mediaType = request.headers["content-type"];
    if (mediaType !== MACHINE_PACK_CONTENT_TYPE) {
      throw new MachineRefusal(
        "invalid_request",
        "a pack upload must be " + MACHINE_PACK_CONTENT_TYPE,
      );
    }
    const declared = request.headers["content-length"];
    if (declared === undefined || !/^[0-9]{1,15}$/u.test(declared)) {
      throw new MachineRefusal(
        "invalid_request",
        "a pack upload must declare a content-length in bytes",
      );
    }
    const length = Number(declared);
    if (length > MAX_CHECKPOINT_PACK_BYTES) {
      throw new MachineRefusal(
        "too_large",
        "a pack of " +
          String(length) +
          " bytes is over the " +
          String(MAX_CHECKPOINT_PACK_BYTES) +
          " byte limit",
      );
    }
    // A plain Uint8Array, not the Buffer fetch hands the socket: the sink receives bytes, and a
    // Buffer's own view would follow every copy of the buffer, not the pack.
    const body = new Uint8Array(
      await Promise.race([readBody(request, MAX_CHECKPOINT_PACK_BYTES), expired]),
    );
    if (body.byteLength !== length) {
      throw new MachineRefusal(
        "invalid_request",
        "the pack body does not match its content-length",
      );
    }
    const headers = parseSignedHeaders(request.headers);
    await Promise.race([
      context.verifier.verify({
        method: request.method ?? "POST",
        path: request.url ?? "",
        headers,
        body,
      }),
      expired,
    ]);
    const admission = context.gate.admit(headers.connection, Number(headers.seq));
    if (admission.kind === "stale") {
      throw new MachineRefusal(
        "stale_connection",
        `a newer connection (seq ${admission.floor}) is current`,
      );
    }
    const sink = context.checkpointPacks;
    if (sink === undefined) {
      throw new MachineRefusal("internal", "the machine has no destination for a checkpoint pack");
    }
    await Promise.race([sink({ runId, bytes: body }), expired]);
    const result: CheckpointPackUploadResult = { runId, receivedBytes: body.byteLength };
    const text = JSON.stringify({ ok: true, op: PACK_RESPONSE_OP, result });
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text, "utf8"),
      connection: "keep-alive",
    });
    response.end(text);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    sendRefusal(response, asRefusal(error));
  } finally {
    clearTimeout(timer);
    context.inFlight.leave();
    logRequest(request, response, context, started, fsPath, undefined);
  }
}

/**
 * The ROOT-relative path a log line names for one operation.
 *
 * @param operation - The parsed operation.
 * @returns A path beginning with one separator, or / for health and an empty relative name.
 *
 * @remarks
 * A wire path may begin with a separator (it means ROOT-relative), so the raw value cannot be
 * concatenated. Normalization is attempted first because it is what the operation itself uses;
 * an unusable path (for example one with ..) still gets a best-effort line: observation must
 * not fail the request.
 */
function logPathOf(operation: Exclude<RpcRequest, GrantedOperation>): string {
  if (operation.op === "health") return "/";
  // A granted call is answered before this is called; the branch keeps the union honest.
  // A checkpoint names a Run, not a file; the log shows it below ROOT like any other path.
  // A mirror names the same Run, and its line names neither the remote nor the token.
  if (operation.op === "checkpoint" || operation.op === "mirror") return "/" + operation.runId;
  // An exec names a working directory, never the command: a command line can carry a secret in
  // an argument, and the log line must not become the place it leaks.
  if (operation.op === "exec") {
    const cwd = operation.cwd ?? "";
    try {
      const relative = normalizeRelative(cwd);
      return relative === "" ? "/" : "/" + relative;
    } catch {
      return "/";
    }
  }
  // The office ops name no ROOT path: a job's `input.path` is workspace-relative and the engine
  // reads it elsewhere, so the log line says only that the op ran.
  if (operation.op === "office" || operation.op === "officeEngine") return "/";
  // A write names a project and a file; the log shows the resolved path, like a read does.
  const project = operation.op === "write" ? operation.projectRoot : "";
  try {
    const relative = normalizeRelative(
      project === "" ? operation.path : project + "/" + operation.path,
    );
    return relative === "" ? "/" : "/" + relative;
  } catch {
    const stripped = (project === "" ? operation.path : project + "/" + operation.path).replace(
      /^[/\\]+/u,
      "",
    );
    return stripped === "" ? "/" : "/" + stripped;
  }
}

/**
 * Write the fs hop line for one finished request.
 *
 * @param request - The incoming request, for the correlation header.
 * @param response - The response, for the status.
 * @param context - The agent context, including the sink.
 * @param started - Epoch milliseconds before the request was read.
 * @param path - The ROOT-relative operation path, or /rpc before one was parsed.
 * @param op - The operation that ran, when it was parsed.
 *
 * @remarks
 * Observation is a side effect: a throwing sink must not change the answer, so the failure is
 * swallowed. The line carries no body, no content, and no token.
 */
function logRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: AgentContext,
  started: number,
  path: string,
  op: OperationName | undefined,
): void {
  try {
    context.onLog(
      machineEntry({
        requestId: requestIdOf(request.headers),
        path,
        status: response.statusCode,
        durationMs: Date.now() - started,
        op,
        now: Date.now(),
      }),
    );
  } catch {
    // Observation must not turn a served request into a failure.
  }
}

/**
 * Read the whole body, refusing over the bound.
 *
 * @param request - The incoming request.
 * @param maxBytes - The largest body to accept.
 * @returns The exact bytes that were signed.
 * @throws {MachineRefusal} `too_large` when the body crosses the bound.
 *
 * @remarks
 * The stream is read to its end instead of destroyed on the way out, so a
 * refusal can still be written: destroying the request would take the socket
 * with it. Bytes past the bound are counted and dropped, never buffered.
 */
function readBody(request: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let oversized = false;
    request.on("data", (chunk: Buffer) => {
      if (oversized) return;
      size += chunk.byteLength;
      if (size > maxBytes) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (oversized) {
        reject(new MachineRefusal("too_large", "the request body is larger than the limit"));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    request.on("error", (error: Error) => {
      reject(error);
    });
  });
}

/**
 * A promise that rejects when the deadline passes.
 *
 * @param signal - The request's deadline signal.
 * @returns A promise that never resolves; the rejection is the abort reason, or
 * `deadline_exceeded` when the signal carries none.
 */
function deadlineExceeded(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const refuse = (): void => {
      const reason = signal.reason;
      reject(reason instanceof MachineRefusal ? reason : deadlineRefusal());
    };
    if (signal.aborted) {
      refuse();
      return;
    }
    signal.addEventListener("abort", refuse, { once: true });
  });
}

/**
 * Turn whatever a request threw into the refusal the caller sees.
 *
 * @param error - The error that ended the request.
 * @returns The typed refusal; an unexpected error is `internal` and its message
 * is not passed on, because it may name a host path.
 */
function asRefusal(error: Error): MachineRefusal {
  if (error instanceof MachineRefusal) return error;
  if (error instanceof Denied) return new MachineRefusal("path_denied", error.message);
  if (error instanceof FileFailure) return refusalForFileFailure(error);
  return new MachineRefusal("internal", "internal error");
}

/**
 * Map a file failure onto the refusal vocabulary.
 *
 * @param failure - A FileFailure from the operation.
 * @returns The refusal with the same meaning: absence is 404, a permission
 * problem is 403, and a request that cannot be honored is 400.
 */
function refusalForFileFailure(failure: FileFailure): MachineRefusal {
  switch (failure.code) {
    case "not_found":
      return new MachineRefusal("not_found", failure.message);
    case "permission_denied":
      return new MachineRefusal("forbidden", failure.message);
    case "not_supported":
      return new MachineRefusal("internal", failure.message);
    case "aborted":
    case "is_directory":
    case "not_directory":
    case "invalid":
      return new MachineRefusal("invalid_request", failure.message);
    case "unknown":
      return new MachineRefusal("internal", failure.message);
  }
  const unreachable: never = failure.code;
  return unreachable;
}

/**
 * Write one successful answer, refusing one that is over the response bound.
 *
 * @param response - The response to write.
 * @param body - The operation and its result.
 * @param limits - The response bound.
 *
 * @remarks
 * The bound is checked on the serialized bytes, so a listing that is large only
 * after encoding is refused instead of truncated: a truncated answer would look
 * complete to the caller.
 */
function sendJson(response: ServerResponse, body: SuccessBody, limits: Limits): void {
  const text = JSON.stringify(body);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > limits.maxResponseBytes) {
    sendRefusal(response, new MachineRefusal("too_large", "the answer is larger than the limit"));
    return;
  }
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": bytes,
    connection: "keep-alive",
  });
  response.end(text);
}

/**
 * Write one refusal.
 *
 * @param response - The response to write.
 * @param refusal - The typed refusal.
 * @param extra - Headers the refusal needs, such as `allow` on a wrong method.
 *
 * @remarks
 * Every refusal asks for the connection to close: a refusal may be written
 * before the body was read, and keeping such a connection alive would leave the
 * request half-consumed.
 */
function sendRefusal(
  response: ServerResponse,
  refusal: MachineRefusal,
  extra: Readonly<Record<string, string>> = {},
): void {
  const body: RefusalBody = { ok: false, code: refusal.code, message: refusal.message };
  const text = JSON.stringify(body);
  response.writeHead(refusalStatus(refusal.code), {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text, "utf8"),
    connection: "close",
    ...extra,
  });
  response.end(text);
}
