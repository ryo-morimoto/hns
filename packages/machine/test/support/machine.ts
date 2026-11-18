import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyObject } from "node:crypto";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { bodyHash, parseResponseBody, startMachineAgent } from "../../src/index.ts";
import type {
  CheckpointPackUpload,
  ControlPlaneKeys,
  Limits,
  MachineAgent,
  MachineLogSink,
  MachineOfficeOptions,
  ResponseBody,
} from "../../src/index.ts";
import { controlPlaneKeys, generateControlPlaneKey, signRequest } from "./control-plane.ts";
import type { ControlPlaneKeyPair } from "./control-plane.ts";

/** The machine id every scenario runs as. */
const MACHINE_ID = "machine-1";

/** The paths one scenario may use: the served root, and a sibling outside it. */
export interface AgentPaths {
  readonly root: string;
  /** A directory beside the root, for files and links that must stay out. */
  readonly base: string;
}

/**
 * One request to send, with the fields a scenario may want to bend.
 *
 * @remarks
 * Mutable: a scenario helper starts from the plain request and sets only the field it is
 * bending, so a call that leaves a field unset is the one an honest client would send.
 */
export interface MachineCall {
  readonly body: string;
  /** The body the signature covers, when a scenario signs one body and sends another. */
  signedBody?: string | undefined;
  readonly connection?: string | undefined;
  /** A positive decimal string, as the header carries it. */
  readonly seq?: string | undefined;
  readonly timestamp?: number | undefined;
  readonly nonce?: string | undefined;
  machineId?: string | undefined;
  readonly method?: string | undefined;
  /** The route to send to and sign for. */
  path?: string | undefined;
  /** The key to sign with, when a scenario presents another signer. */
  signingKey?: KeyObject | undefined;
  /** Send no signature headers at all. */
  unsigned?: boolean | undefined;
  /** The correlation header; it is not part of the signed message. */
  readonly requestId?: string | undefined;
  /**
   * Send a body that is not JSON: the raw bytes, and the media type to label them with.
   *
   * @remarks
   * A pack upload is the only body the agent reads that is not JSON. `body` is still what the
   * signature covers unless `signedBody` overrides it, so a scenario can sign one pack and
   * send another.
   */
  readonly rawBody?: { readonly bytes: Uint8Array; readonly contentType: string } | undefined;
  /**
   * A header `fetch` would not send as written, for a raw request.
   *
   * @remarks
   * `fetch` writes the `content-length` of the body it is given and replaces one given by hand,
   * so a request whose declared framing must differ from its body (a length over the limit with
   * no body, a missing or non-numeric length) is written on a socket through
   * {@link rawCall}. The signature is computed exactly as {@link call} does it.
   */
  raw?: { readonly header: string; readonly value: string | undefined } | undefined;
  /**
   * Bytes to send that the signature does not cover.
   *
   * @remarks
   * `rawBody` is what is signed; this is what travels. A scenario that signs one body and sends
   * another uses it, which `signedBody` cannot express once either body is not text.
   */
  readonly sentBody?: Uint8Array | undefined;
  /** The declared `content-length`, when it is not the body's own. */
  readonly declaredLength?: string | undefined;
}

/** What the agent answered, already parsed at the boundary. */
export interface MachineAnswer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: ResponseBody;
}

/**
 * Send one request over real HTTP to a running agent, signed by a control plane.
 *
 * @param call - The origin, the machine id, the signing key, and the request.
 * @returns The status, headers, and parsed body.
 */
async function callMachine(
  call: MachineCall & {
    readonly origin: string;
    readonly defaultMachineId: string;
    readonly signingKey: KeyObject;
  },
): Promise<MachineAnswer> {
  const method = call.method ?? "POST";
  const path = call.path ?? "/rpc";
  const connection = call.connection ?? "connection-1";
  const seq = call.seq ?? "1";
  const timestamp = String(call.timestamp ?? Date.now());
  const nonce = call.nonce ?? randomUUID();
  const machineId = call.machineId ?? call.defaultMachineId;
  // A copy on a plain ArrayBuffer: what fetch accepts as a BodyInit, and what was signed.
  const raw = call.rawBody === undefined ? undefined : new Uint8Array(call.rawBody.bytes);
  const signed = raw ?? new TextEncoder().encode(call.signedBody ?? call.body);
  const headers = new Headers({ "content-type": call.rawBody?.contentType ?? "application/json" });
  if (call.requestId !== undefined) headers.set("x-request-id", call.requestId);
  if (call.unsigned !== true) {
    const signature = signRequest(
      { machineId, connection, seq, timestamp, nonce, method, path, bodyHash: bodyHash(signed) },
      call.signingKey,
    );
    headers.set("x-hns-machine", machineId);
    headers.set("x-hns-connection", connection);
    headers.set("x-hns-seq", seq);
    headers.set("x-hns-timestamp", timestamp);
    headers.set("x-hns-nonce", nonce);
    headers.set("x-hns-signature", signature);
  }
  const sent = call.sentBody === undefined ? undefined : new Uint8Array(call.sentBody);
  const body = sent ?? raw ?? new TextEncoder().encode(call.body);
  if (call.raw !== undefined) {
    return await rawCall({ origin: call.origin, method, path, headers, body, framing: call.raw });
  }
  const response = await fetch(call.origin + path, {
    method,
    headers,
    body: method === "GET" ? null : body,
    redirect: "error",
  });
  return {
    status: response.status,
    headers: response.headers,
    body: parseResponseBody(await response.text()),
  };
}

/**
 * Write one signed request on a socket, with its headers exactly as given.
 *
 * @param request - The origin, the method, the path, the signed headers, the body, and the one
 * header that differs from what the body would imply.
 * @returns The status, headers, and parsed body.
 *
 * @remarks
 * The body is written after the header, so a request declaring more than it sends is answered
 * on the header alone (the agent refuses over the limit before it reads) or on the short body
 * (the agent reads what arrived and refuses the mismatch). The answer is chunked, so the frames
 * are joined before the body is parsed.
 */
async function rawCall(request: {
  readonly origin: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
  readonly framing: { readonly header: string; readonly value: string | undefined };
}): Promise<MachineAnswer> {
  const url = new URL(request.origin);
  const socket = connect({ host: url.hostname, port: Number(url.port) });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  // The socket's own error is expected when the agent cuts the connection: the refusal is what
  // the answer carries, and a client that keeps sending after it is what made the error.
  socket.on("error", () => undefined);
  const lines: string[] = [];
  request.headers.forEach((value, name) => {
    if (name !== request.framing.header) lines.push(name + ": " + value);
  });
  // A value of undefined writes no header at all, which is the "declared nothing" case.
  if (request.framing.value !== undefined) {
    lines.push(request.framing.header + ": " + request.framing.value);
  }
  socket.write(request.method + " " + request.path + " HTTP/1.1\r\nhost: " + url.host + "\r\n");
  socket.write(lines.join("\r\n") + "\r\n\r\n");
  // A body longer than the length written is half-sent: the agent answers on what it declared
  // and closes, and continuing to send into the closed socket is not part of the scenario.
  const declared = Number(request.framing.value);
  const sent =
    Number.isSafeInteger(declared) && declared >= 0
      ? request.body.subarray(0, Math.min(declared, request.body.byteLength))
      : request.body;
  socket.write(sent);
  const text = await readAll(socket);
  const separator = text.indexOf("\r\n\r\n");
  const status = Number(/^HTTP\/1\.1 ([0-9]{3})/u.exec(text)?.[1] ?? "0");
  // Node's HTTP parser answers a malformed request by closing the connection and, by default,
  // writing no response at all; the client then sees a closed socket. Such an answer is a
  // refusal the caller has to treat as one, so it is surfaced with a status of 0 rather than
  // thrown.
  const chunks = separator === -1 ? "" : text.slice(separator + 4);
  // Node's HTTP parser answers a malformed request by closing the connection and, by default,
  // writing no response at all; the client then sees an empty answer. Such an answer is a
  // refusal the caller has to treat as one, so it is surfaced with a status of 0 rather than
  // thrown.
  if (text === "") {
    return {
      status: 0,
      headers: new Headers(),
      body: {
        ok: false,
        code: "invalid_request",
        message: "the connection closed before an answer",
      },
    };
  }
  const parsed = decodeChunks(chunks);
  try {
    return { status, headers: new Headers(), body: parseResponseBody(parsed) };
  } catch {
    return {
      status,
      headers: new Headers(),
      body: { ok: false, code: "invalid_request", message: parsed },
    };
  }
}

/**
 * Join the data frames of a chunked body.
 *
 * @param raw - Everything after the header block, still chunk-framed.
 * @returns The joined body text; text that is not chunked is returned as it is.
 */
function decodeChunks(raw: string): string {
  let offset = 0;
  let body = "";
  for (;;) {
    const line = raw.indexOf("\r\n", offset);
    if (line === -1) return body === "" ? raw : body;
    const size = Number.parseInt(raw.slice(offset, line).trim(), 16);
    if (!Number.isSafeInteger(size) || size < 0) return body === "" ? raw : body;
    if (size === 0) return body;
    body += raw.slice(line + 2, line + 2 + size);
    offset = line + 2 + size + 2;
  }
}

/** A running agent and the ways a test drives it. */
export interface AgentFixture extends AgentPaths {
  readonly agent: MachineAgent;
  readonly machineId: string;
  /** The control-plane key the fixture signs with unless a call names another. */
  readonly signingKey: KeyObject;
  readonly controlPlane: ControlPlaneKeys;
  readonly origin: string;
  readonly port: number;
  call(input: MachineCall): Promise<MachineAnswer>;
}

/** How to vary the agent a scenario runs against. */
export interface AgentSetup {
  readonly limits?: Partial<Limits> | undefined;
  /** The enrolled keys; defaults to one fresh control-plane key. */
  readonly controlPlane?: ControlPlaneKeys | undefined;
  /** The key the fixture signs with by default; defaults to the fresh key. */
  readonly signingKey?: KeyObject | undefined;
  readonly machineId?: string | undefined;
  /** Where the agent's fs log lines go; defaults to stderr. */
  readonly onLog?: MachineLogSink | undefined;
  /** Where an accepted checkpoint pack goes; unset refuses every upload. */
  readonly onCheckpointPack?: ((upload: CheckpointPackUpload) => Promise<void>) | undefined;
  /** The office engine's installation; unset means this agent runs no office job. */
  readonly office?: MachineOfficeOptions | undefined;
  /**
   * The office cache's directory, when a scenario wants to look inside it; unset lets the agent
   * choose its default (`$XDG_CACHE_HOME/hns/office`).
   *
   * @remarks
   * It is folded into {@link office} rather than passed beside it, because the cache is the
   * office engine's: an agent without an engine has no cache to name.
   */
  readonly cacheRoot?: string | undefined;
}

/**
 * Run one scenario against a fresh root and a fresh agent, then clean up.
 *
 * @param scenario - Creates the files and links the test needs.
 * @param run - The test body.
 * @param setup - Limits, an enrollment, or a signing key to substitute.
 */
export async function withAgent(
  scenario: (paths: AgentPaths) => Promise<void>,
  run: (fixture: AgentFixture) => Promise<void>,
  setup: AgentSetup = {},
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "hns-machine-"));
  const root = join(base, "root");
  await mkdir(root);
  const pair: ControlPlaneKeyPair = generateControlPlaneKey();
  const machineId = setup.machineId ?? MACHINE_ID;
  // The sink is optional: only a scenario that receives a checkpoint pack passes one.
  const sink =
    setup.onCheckpointPack === undefined ? {} : { onCheckpointPack: setup.onCheckpointPack };
  // The cache directory is named here so a scenario can look inside it: the default would be the
  // developer's own ~/.cache, which a test must not read or write.
  const cacheRoot = setup.cacheRoot ?? join(base, "office-cache");
  const office =
    setup.office === undefined
      ? {}
      : { office: { ...setup.office, cacheRoot: setup.office.cacheRoot ?? cacheRoot } };
  const agent = await startMachineAgent({
    root,
    machineId,
    controlPlane: setup.controlPlane ?? controlPlaneKeys([pair]),
    port: 0,
    limits: setup.limits ?? {},
    // Integration tests are otherwise silent; a scenario that proves the log passes a sink.
    onLog: setup.onLog ?? (() => undefined),
    ...sink,
    ...office,
  });
  const signingKey = setup.signingKey ?? pair.privateKey;
  try {
    await scenario({ root, base });
    await run({
      root,
      base,
      agent,
      machineId,
      signingKey,
      controlPlane: setup.controlPlane ?? controlPlaneKeys([pair]),
      origin: agent.origin,
      port: agent.port,
      call: (input: MachineCall) =>
        callMachine({
          ...input,
          origin: agent.origin,
          defaultMachineId: machineId,
          signingKey: input.signingKey ?? signingKey,
        }),
    });
  } finally {
    await agent.close();
    await rm(base, { recursive: true, force: true });
  }
}

/**
 * Wait until an observable condition holds, then return.
 *
 * @param predicate - The condition to poll; it reads state, it does not sleep.
 * @param label - What is being waited for, for the failure message.
 * @param timeoutMs - How long to wait before failing the test.
 */
export async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

/**
 * Open a request whose body never finishes: the headers claim 4096 bytes and a
 * single byte follows.
 *
 * @param port - The agent's local port.
 * @param bodyPrefix - The bytes to send after the headers.
 * @returns The connected socket, held open by the caller.
 */
export async function openSuspendedRequest(port: number, bodyPrefix: string): Promise<Socket> {
  const socket = connect({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => {
      resolve();
    });
    socket.once("error", reject);
  });
  socket.write(
    "POST /rpc HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: 4096\r\n\r\n" +
      bodyPrefix,
  );
  return socket;
}

/**
 * Collect everything a socket sends until it closes.
 *
 * @param socket - The connected socket.
 * @returns The raw response text.
 */
export function readAll(socket: Socket): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    socket.on("end", () => {
      resolve(text);
    });
    socket.on("close", () => {
      resolve(text);
    });
    socket.on("error", (error: Error) => {
      reject(error);
    });
  });
}
