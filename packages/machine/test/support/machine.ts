import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyObject } from "node:crypto";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { bodyHash, parseResponseBody, signRequest, startMachineAgent } from "../../src/index.ts";
import type { Limits, MachineAgent, MachineKeyRegistry, ResponseBody } from "../../src/index.ts";
import { generateMachineKeys } from "./keys.ts";
import type { MachineKeys } from "./keys.ts";

/** The paths one scenario may use: the served root, and a sibling outside it. */
export interface AgentPaths {
  readonly root: string;
  /** A directory beside the root, for files and links that must stay out. */
  readonly base: string;
}

/** One request to send, with the fields a scenario may want to bend. */
interface MachineCall {
  readonly body: string;
  /** The body the signature covers, when a scenario signs one body and sends another. */
  readonly signedBody?: string | undefined;
  readonly connection?: string | undefined;
  /** A positive decimal string, as the header carries it. */
  readonly seq?: string | undefined;
  readonly timestamp?: number | undefined;
  readonly nonce?: string | undefined;
  readonly machineId?: string | undefined;
  readonly method?: string | undefined;
  readonly path?: string | undefined;
  /** The key to sign with, when a scenario presents another machine. */
  readonly signingKey?: KeyObject | undefined;
  /** Send no signature headers at all. */
  readonly unsigned?: boolean | undefined;
}

/** What the agent answered, already parsed at the boundary. */
export interface MachineAnswer {
  readonly status: number;
  readonly body: ResponseBody;
}

/**
 * Send one request over real HTTP to a running agent.
 *
 * @param call - The origin, the keys, and the request to sign and send.
 * @returns The status and the parsed body.
 */
async function callMachine(
  call: MachineCall & { readonly keys: MachineKeys; readonly origin: string },
): Promise<MachineAnswer> {
  const method = call.method ?? "POST";
  const path = call.path ?? "/rpc";
  const connection = call.connection ?? "connection-1";
  const seq = call.seq ?? "1";
  const timestamp = String(call.timestamp ?? Date.now());
  const nonce = call.nonce ?? randomUUID();
  const machineId = call.machineId ?? call.keys.machineId;
  const signed = new TextEncoder().encode(call.signedBody ?? call.body);
  const headers = new Headers({ "content-type": "application/json" });
  if (call.unsigned !== true) {
    const signature = signRequest(
      { machineId, connection, seq, timestamp, nonce, method, path, bodyHash: bodyHash(signed) },
      call.signingKey ?? call.keys.privateKey,
    );
    headers.set("x-hns-machine", machineId);
    headers.set("x-hns-connection", connection);
    headers.set("x-hns-seq", seq);
    headers.set("x-hns-timestamp", timestamp);
    headers.set("x-hns-nonce", nonce);
    headers.set("x-hns-signature", signature);
  }
  const response = await fetch(call.origin + path, {
    method,
    headers,
    body: method === "GET" ? null : new TextEncoder().encode(call.body),
    redirect: "error",
  });
  return { status: response.status, body: parseResponseBody(await response.text()) };
}

/** A running agent and the ways a test drives it. */
export interface AgentFixture extends AgentPaths {
  readonly agent: MachineAgent;
  readonly keys: MachineKeys;
  readonly origin: string;
  readonly port: number;
  call(input: MachineCall): Promise<MachineAnswer>;
}

/** How to vary the agent a scenario runs against. */
export interface AgentSetup {
  readonly limits?: Partial<Limits> | undefined;
  readonly registry?: MachineKeyRegistry | undefined;
}

/**
 * Run one scenario against a fresh root and a fresh agent, then clean up.
 *
 * @param scenario - Creates the files and links the test needs.
 * @param run - The test body.
 * @param setup - Limits or a key registry to substitute.
 */
export async function withAgent(
  scenario: (paths: AgentPaths) => Promise<void>,
  run: (fixture: AgentFixture) => Promise<void>,
  setup: AgentSetup = {},
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "hns-machine-"));
  const root = join(base, "root");
  await mkdir(root);
  const keys = generateMachineKeys("machine-1");
  const agent = await startMachineAgent({
    root,
    machineId: keys.machineId,
    keys: setup.registry ?? keys.registry,
    port: 0,
    limits: setup.limits ?? {},
  });
  try {
    await scenario({ root, base });
    await run({
      root,
      base,
      agent,
      keys,
      origin: agent.origin,
      port: agent.port,
      call: (input: MachineCall) => callMachine({ ...input, keys, origin: agent.origin }),
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
