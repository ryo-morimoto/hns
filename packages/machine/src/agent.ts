import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { realpath, stat } from "node:fs/promises";
import * as v from "valibot";
import { Denied, FileFailure } from "@hns/workspace";
import type { RootIdentity } from "@hns/workspace";
import { ConnectionGate } from "./connection.ts";
import { normalizeRelative } from "./containment.ts";
import { InFlight, resolveLimits } from "./limits.ts";
import type { Limits } from "./limits.ts";
import { machineEntry, requestIdOf, writeMachineLog, type MachineLogSink } from "./log.ts";
import { runOperation } from "./operations.ts";
import { MachineRefusal, refusalStatus } from "./refusal.ts";
import { RequestVerifier } from "./signature.ts";
import type { ControlPlaneKeys } from "./control-plane.ts";
import { parseOperation, parseSignedHeaders } from "./wire.ts";
import type { Operation, OperationName, RefusalBody, SuccessBody } from "./wire.ts";

/** The only address the agent ever listens on: cloudflared connects from here. */
const HOST = "127.0.0.1";

/** The only route the agent answers. */
const RPC_PATH = "/rpc";

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
}

/** A running agent. */
export interface MachineAgent {
  /** `http://127.0.0.1:<port>`, the address cloudflared proxies to. */
  readonly origin: string;
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
}

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
  let fsPath = "/rpc";
  let op: OperationName | undefined;
  if (request.method !== "POST") {
    sendRefusal(response, new MachineRefusal("method_not_allowed", "the agent answers POST only"), {
      allow: "POST",
    });
    logRequest(request, response, context, started, fsPath, op);
    return;
  }
  if (request.url !== RPC_PATH) {
    sendRefusal(response, new MachineRefusal("not_found", "the agent answers /rpc only"));
    logRequest(request, response, context, started, fsPath, op);
    return;
  }
  if (!context.inFlight.enter()) {
    sendRefusal(response, new MachineRefusal("busy", "too many requests are in flight"));
    logRequest(request, response, context, started, fsPath, op);
    return;
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(deadlineRefusal()), context.limits.timeoutMs);
  const expired = deadlineExceeded(deadline.signal);
  try {
    const body = await Promise.race([readBody(request, context.limits.maxRequestBytes), expired]);
    const headers = parseSignedHeaders(request.headers);
    await Promise.race([
      context.verifier.verify({ method: request.method, path: request.url, headers, body }),
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
    fsPath = logPathOf(operation);
    const result = await runOperation(
      operation,
      context.root,
      context.limits,
      deadline.signal,
      context.identity,
    );
    sendJson(response, { ok: true, op, result }, context.limits);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    sendRefusal(response, asRefusal(error));
  } finally {
    clearTimeout(timer);
    context.inFlight.leave();
    logRequest(request, response, context, started, fsPath, op);
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
function logPathOf(operation: Operation): string {
  if (operation.op === "health") return "/";
  try {
    const relative = normalizeRelative(operation.path);
    return relative === "" ? "/" : "/" + relative;
  } catch {
    const stripped = operation.path.replace(/^[/\\]+/u, "");
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
