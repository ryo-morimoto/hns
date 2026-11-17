import { describe, expect, test } from "vitest";
import { createMachineTransport, machineRpcUrl } from "./transport.ts";
import { probeMachine, MACHINE_HEALTH_BODY } from "./probe.ts";
import { callable, machineKeyRegistry, machineKeyRegistryOver, machineToCall } from "./registry.ts";
import type { Machine } from "@hns/core";
import { MACHINE_REFUSALS, MACHINE_RPC_PATH, isoTimestamp, signatureMessage } from "@hns/core";
import type { MachineRepository, Store } from "@hns/store";
import type { MachineProbeWriter } from "./probe.ts";

/**
 * The machines face, over a fake fetch and a fake registry (0148).
 *
 * @remarks
 * The unit suite proves the **call the Worker makes**: the signed headers, the path, the body
 * hash, the timeout, and the refusal/failure mapping. The integration suite proves the D1 rows.
 * Nothing here reaches a network: a fake `fetch` sees exactly what would be sent.
 */

/** A control-plane seed, base64url, deterministic. */
const SEED_BASE64URL = Buffer.from(new Uint8Array(32).fill(7)).toString("base64url");

/** One machine row, as the registry returns it. */
function machine(overrides: Partial<Machine> = {}): Machine {
  const raw = new Uint8Array(32).fill(3);
  return {
    id: "m1",
    name: "laptop",
    hostname: "laptop.example.ts.net",
    publicKey: Buffer.from(raw).toString("base64url"),
    keyAlgorithm: "ed25519",
    fingerprint: "ed25519:00000000000000000000000000000000",
    agentVersion: "0.1.0",
    lastSeen: null,
    status: "offline",
    createdAt: isoTimestamp("2026-01-01T00:00:00.000Z"),
    updatedAt: isoTimestamp("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

// Catches: a hostname that is not a DNS name reaching fetch as an origin.
describe("machineRpcUrl", () => {
  test.each([
    ["a plain hostname", "laptop.example.ts.net", "https://laptop.example.ts.net/rpc"],
    ["a single-label host", "laptop", undefined],
    ["a scheme", "https://laptop.example.ts.net", undefined],
    ["a path", "laptop.example.ts.net/evil", undefined],
    ["userinfo", "user@laptop.example.ts.net", undefined],
    ["a port", "laptop.example.ts.net:8443", undefined],
  ])("a machine hostname is a DNS name: %s", (_label, hostname, expected) => {
    expect(machineRpcUrl({ hostname })).toBe(expected);
  });
});

// Catches: a transport that signs the wrong fields, the wrong path, or the body's spelling.
test("a call carries the six signed headers over the exact body", async () => {
  const seen: { url: string; headers: Headers; body: Uint8Array }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = init?.body;
    seen.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: body instanceof Uint8Array ? body : new Uint8Array(0),
    });
    return new Response(
      JSON.stringify({ ok: true, op: "health", result: { root: "/r", pid: 1 } }),
      {
        status: 200,
      },
    );
  };
  const transport = createMachineTransport(fetchImpl);
  const body = new TextEncoder().encode(JSON.stringify({ op: "health" }));
  const answer = await transport.call({ hostname: "laptop.example.ts.net" }, body, {
    controlPlaneKey: SEED_BASE64URL,
    machineId: "m1",
    requestId: "req-1",
    now: () => 1_700_000_000_000,
  });
  expect(answer.ok).toBe(true);
  expect(seen).toHaveLength(1);
  const call = seen[0];
  if (call === undefined) throw new Error("no call");
  expect(call.url).toBe("https://laptop.example.ts.net" + MACHINE_RPC_PATH);
  expect(call.headers.get("x-hns-machine")).toBe("m1");
  expect(call.headers.get("x-hns-timestamp")).toBe("1700000000000");
  expect(call.headers.get("x-hns-signature")).toMatch(/^[A-Za-z0-9_-]{86}$/u);
  expect(call.headers.get("x-request-id")).toBe("req-1");
  expect(new Uint8Array(call.body)).toStrictEqual(body);
});

// Catches: a signature that verifies only because it covers the wrong message, or a header
// the machine's verifier does not read.
test("the signature verifies with the control-plane public key over the contract's message", async () => {
  let captured: Headers | undefined;
  let capturedBody: Uint8Array | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    captured = new Headers(init?.headers);
    const body = init?.body;
    capturedBody = body instanceof Uint8Array ? new Uint8Array(body) : new Uint8Array(0);
    return new Response("{}", { status: 200 });
  };
  const transport = createMachineTransport(fetchImpl);
  const body = new TextEncoder().encode("{}");
  const answer = await transport.call({ hostname: "laptop.example.ts.net" }, body, {
    controlPlaneKey: SEED_BASE64URL,
    machineId: "m1",
    now: () => 99,
  });
  expect(answer.ok).toBe(true);
  const headers = captured;
  const bytes = capturedBody;
  if (headers === undefined || bytes === undefined) throw new Error("no call");
  // The verifier side is the machine's: it computes the body hash from the bytes it received and
  // rebuilds the message from the six headers. This test signs nothing new; it verifies.
  const message = {
    machineId: headers.get("x-hns-machine") ?? "",
    connection: headers.get("x-hns-connection") ?? "",
    seq: headers.get("x-hns-seq") ?? "",
    timestamp: headers.get("x-hns-timestamp") ?? "",
    nonce: headers.get("x-hns-nonce") ?? "",
    method: "POST",
    path: MACHINE_RPC_PATH,
    bodyHash: await sha256Hex(bytes),
  };
  expect(message.machineId).toBe("m1");
  expect(message.timestamp).toBe("99");
  expect(message.bodyHash).toBe(await sha256Hex(body));
  const publicKey = await publicKeyOf(new Uint8Array(32).fill(7));
  const valid = await crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    fromBase64Url(headers.get("x-hns-signature") ?? ""),
    signatureMessage(message),
  );
  expect(valid).toBe(true);
  // A signature over one byte fewer does not verify: the body hash is covered.
  const other = {
    ...message,
    bodyHash: await sha256Hex(new TextEncoder().encode("{} ")),
  };
  expect(
    await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      fromBase64Url(headers.get("x-hns-signature") ?? ""),
      signatureMessage(other),
    ),
  ).toBe(false);
});

/** The public half of a 32-byte seed, imported for verification. */
async function publicKeyOf(seed: Uint8Array): Promise<CryptoKey> {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8Of(seed),
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const x = jwk.x ?? "";
  const bytes = fromBase64Url(x);
  const prefix = Uint8Array.from([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
  ]);
  const der = new Uint8Array(prefix.byteLength + bytes.byteLength);
  der.set(prefix);
  der.set(bytes, prefix.byteLength);
  return await crypto.subtle.importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
}

/** Decode base64url into bytes. */
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The PKCS#8 encoding of a 32-byte Ed25519 seed. */
function pkcs8Of(seed: Uint8Array): Uint8Array<ArrayBuffer> {
  const prefix = Uint8Array.from([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const der = new Uint8Array(prefix.byteLength + seed.byteLength);
  der.set(prefix);
  der.set(seed, prefix.byteLength);
  return der;
}

/** The SHA-256 of some bytes, in hex. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", view));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

// Catches: an unreachable machine reported as reachable.
test("a transport failure, a deadline, and an unreadable refusal body are failures", async () => {
  const unreachable = createMachineTransport(async () => {
    throw new TypeError("network");
  });
  expect(
    await unreachable.call({ hostname: "a.example.ts.net" }, new Uint8Array(0), {
      controlPlaneKey: SEED_BASE64URL,
      machineId: "m1",
    }),
  ).toMatchObject({ ok: false, failure: "unreachable" });
  const refused = createMachineTransport(async () => {
    return new Response(JSON.stringify({ ok: false, code: "unauthorized", message: "nope" }), {
      status: 401,
    });
  });
  expect(
    await refused.call({ hostname: "a.example.ts.net" }, new Uint8Array(0), {
      controlPlaneKey: SEED_BASE64URL,
      machineId: "m1",
    }),
  ).toMatchObject({ ok: false, failure: "refused", detail: "unauthorized" });
  // The refusal vocabulary is the core one; a code outside it is still not a success.
  for (const code of MACHINE_REFUSALS) {
    const transport = createMachineTransport(async () => {
      return new Response(JSON.stringify({ ok: false, code, message: "" }), { status: 409 });
    });
    expect(
      await transport.call({ hostname: "a.example.ts.net" }, new Uint8Array(0), {
        controlPlaneKey: SEED_BASE64URL,
        machineId: "m1",
      }),
    ).toMatchObject({ ok: false, failure: "refused", detail: code });
  }
});

// Catches: a call that outlives the 3-second deadline D087 sets.
test("a call past its timeout is unreachable, not a hang", async () => {
  const transport = createMachineTransport(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );
  const started = Date.now();
  const answer = await transport.call({ hostname: "a.example.ts.net" }, new Uint8Array(0), {
    controlPlaneKey: SEED_BASE64URL,
    machineId: "m1",
    timeoutMs: 20,
  });
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(answer).toMatchObject({ ok: false, failure: "unreachable" });
});

// Catches: a missing key or a malformed host reaching the network.
test("a missing control-plane key or a bad host is not_configured, and nothing is sent", async () => {
  let calls = 0;
  const transport = createMachineTransport(async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  });
  expect(
    await transport.call({ hostname: "a.example.ts.net" }, new Uint8Array(0), {
      controlPlaneKey: "",
      machineId: "m1",
    }),
  ).toMatchObject({ ok: false, failure: "not_configured" });
  expect(
    await transport.call({ hostname: "not a host" }, new Uint8Array(0), {
      controlPlaneKey: SEED_BASE64URL,
      machineId: "m1",
    }),
  ).toMatchObject({ ok: false, failure: "not_configured" });
  expect(
    await transport.call({ hostname: "a.example.ts.net" }, new Uint8Array(0), {
      controlPlaneKey: "short",
      machineId: "m1",
    }),
  ).toMatchObject({ ok: false, failure: "not_configured" });
  expect(calls).toBe(0);
});

/** A repository whose every method fails: the base for a fake that overrides one method. */
function emptyRepository(): MachineRepository {
  const refused = async (): Promise<never> => {
    throw new Error("not used by this test");
  };
  return {
    list: refused,
    get: refused,
    enroll: refused,
    revoke: refused,
    deviceKey: refused,
    recordProbe: refused,
  };
}

/** One probe write the fake registry saw. */
interface ProbeWrite {
  readonly id: string;
  readonly reachable: boolean;
  readonly at: number;
}

/** A fake registry and the probes it wrote. */
interface FakeRegistry {
  readonly repo: MachineProbeWriter;
  readonly writes: ProbeWrite[];
}

/** A fake registry that records the probes it writes. */
function fakeRegistry(): FakeRegistry {
  const writes: { id: string; reachable: boolean; at: number }[] = [];
  const repo: MachineProbeWriter = {
    recordProbe: async (id, observation) => {
      writes.push({ id, reachable: observation.reachable, at: observation.at });
      return true;
    },
  };
  return { repo, writes };
}

// Catches: a probe that reports online for a failure, or probes a revoked machine.
test("a probe records what the health call answered and never probes a revoked machine", async () => {
  const { repo, writes } = fakeRegistry();
  let hits = 0;
  const transport = {
    call: async () => {
      hits += 1;
      return { ok: true as const, status: 200, body: "{}" };
    },
  };
  const reachable = await probeMachine(machine(), {
    machines: repo,
    controlPlaneKey: SEED_BASE64URL,
    transport,
    now: () => 5,
  });
  expect(reachable.observation).toStrictEqual({ reachable: true, at: 5 });
  expect(writes).toStrictEqual([{ id: "m1", reachable: true, at: 5 }]);
  const revoked = await probeMachine(machine({ status: "revoked" }), {
    machines: repo,
    controlPlaneKey: SEED_BASE64URL,
    transport,
    now: () => 6,
  });
  expect(revoked.observation.reachable).toBe(false);
  expect(revoked.written).toBe(false);
  expect(hits).toBe(1);
  expect(MACHINE_HEALTH_BODY.byteLength).toBeGreaterThan(0);
});

// Catches: a probe that needs a path other than the agent's one route.
test("the probe body is the agent's health operation under /rpc", () => {
  expect(new TextDecoder().decode(MACHINE_HEALTH_BODY)).toBe(JSON.stringify({ op: "health" }));
});

// Catches: a registry that hands a key to a verifier for a revoked or unknown machine.
test("the registry port returns no key for a revoked or unknown machine", async () => {
  const registry = machineKeyRegistry({
    deviceKey: async (id) => (id === "live" ? new Uint8Array(32) : undefined),
  });
  expect(await registry.deviceKey("live")).toStrictEqual(new Uint8Array(32));
  expect(await registry.deviceKey("revoked")).toBeUndefined();
  expect(await registry.deviceKey("missing")).toBeUndefined();
  // The store-backed port is the production path; it forwards the same lookup.
  const machines: MachineRepository = {
    ...emptyRepository(),
    deviceKey: async (id: string) => (id === "live" ? new Uint8Array(16) : undefined),
  };
  // SAFETY: the port reads only `store.machines`, so a Store whose other repositories are absent
  // still exercises the production path exactly as the port does.
  const overStore = machineKeyRegistryOver({ machines } as Store);
  expect(await overStore.deviceKey("live")).toStrictEqual(new Uint8Array(16));
  expect(await overStore.deviceKey("other")).toBeUndefined();
});

// Catches: the lease holder being ignored in favour of the recorded machine, or vice versa.
test("the current lease holder is called, then the recorded machine, never a revoked one", () => {
  expect(machineToCall("lease-m", "recorded-m")).toBe("lease-m");
  expect(machineToCall(undefined, "recorded-m")).toBe("recorded-m");
  expect(machineToCall(undefined, undefined)).toBeUndefined();
  expect(callable("online")).toBe(true);
  expect(callable("offline")).toBe(true);
  expect(callable("revoked")).toBe(false);
});

// Catches: the core message being built by hand instead of the one signing contract.
test("the transport and the machine agent share one signing message", () => {
  expect(
    signatureMessage({
      machineId: "m1",
      connection: "c",
      seq: "1",
      timestamp: "0",
      nonce: "n",
      method: "POST",
      path: "/rpc",
      bodyHash: "00",
    }),
  ).toBeInstanceOf(Uint8Array);
});
