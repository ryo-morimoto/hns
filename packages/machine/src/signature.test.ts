import { expect, test } from "vitest";
import { verificationKey } from "./control-plane.ts";
import { MachineRefusal } from "./refusal.ts";
import { NonceCache, RequestVerifier, bodyHash, verifyRequestSignature } from "./signature.ts";
import type { VerifiableRequest } from "./signature.ts";
import {
  controlPlaneKeys,
  generateControlPlaneKey,
  signRequest,
} from "../test/support/control-plane.ts";
import type { ControlPlaneKeyPair } from "../test/support/control-plane.ts";

const NOW = 1_700_000_000_000;
const WINDOW_MS = 60_000;
const MACHINE_ID = "machine-1";

interface RequestOptions {
  readonly timestamp?: string;
  readonly nonce?: string;
  readonly connection?: string;
  readonly seq?: string;
  readonly method?: string;
  readonly path?: string;
}

/** One request, signed by a control-plane key the way the Worker would sign it. */
function signed(
  pair: ControlPlaneKeyPair,
  body: string,
  options: RequestOptions = {},
): VerifiableRequest {
  const bytes = new TextEncoder().encode(body);
  const connection = options.connection ?? "connection-1";
  const seq = options.seq ?? "1";
  const timestamp = options.timestamp ?? String(NOW);
  const nonce = options.nonce ?? "nonce-0123456789abcdef";
  const method = options.method ?? "POST";
  const path = options.path ?? "/rpc";
  return {
    method,
    path,
    body: bytes,
    headers: {
      machineId: MACHINE_ID,
      connection,
      seq,
      timestamp,
      nonce,
      signature: signRequest(
        {
          machineId: MACHINE_ID,
          connection,
          seq,
          timestamp,
          nonce,
          method,
          path,
          bodyHash: bodyHash(bytes),
        },
        pair.privateKey,
      ),
    },
  };
}

function verifierFor(pairs: readonly ControlPlaneKeyPair[]): RequestVerifier {
  return new RequestVerifier({
    machineId: MACHINE_ID,
    controlPlane: controlPlaneKeys(pairs),
    now: () => NOW,
    windowMs: WINDOW_MS,
  });
}

/** The refusal a rejected verify produced, checked to be a refusal. */
async function refusalOf(promise: Promise<void>): Promise<MachineRefusal> {
  const error = await promise.then(
    () => undefined,
    (reason: Error) => reason,
  );
  if (!(error instanceof MachineRefusal)) throw new Error("the verifier did not refuse");
  return error;
}

test("the window accepts its boundary and refuses beyond it", async () => {
  const pair = generateControlPlaneKey();
  const verifier = verifierFor([pair]);
  for (const [index, timestamp] of [NOW - WINDOW_MS, NOW, NOW + WINDOW_MS].entries()) {
    await expect(
      verifier.verify(
        signed(pair, "{}", { timestamp: String(timestamp), nonce: `accepted-${index}-nonce` }),
      ),
    ).resolves.toBeUndefined();
  }
  const past = await refusalOf(
    verifier.verify(
      signed(pair, "{}", { timestamp: String(NOW - WINDOW_MS - 1), nonce: "past-request-nonce" }),
    ),
  );
  expect(past.code).toBe("stale_request");
  const future = await refusalOf(
    verifier.verify(
      signed(pair, "{}", { timestamp: String(NOW + WINDOW_MS + 1), nonce: "future-request-nonce" }),
    ),
  );
  expect(future.code).toBe("stale_request");
});

test("a replayed nonce is refused", async () => {
  const pair = generateControlPlaneKey();
  const verifier = verifierFor([pair]);
  const request = signed(pair, "{}", { nonce: "replay-request-nonce" });
  await expect(verifier.verify(request)).resolves.toBeUndefined();
  const refusal = await refusalOf(verifier.verify(request));
  expect(refusal.code).toBe("replayed");
});

test("a failed signature does not consume the nonce", async () => {
  const pair = generateControlPlaneKey();
  const verifier = verifierFor([pair]);
  const request = signed(pair, "{}", { nonce: "tamper-request-nonce" });
  const tampered: VerifiableRequest = {
    ...request,
    body: new TextEncoder().encode('{"tampered":true}'),
  };
  const refusal = await refusalOf(verifier.verify(tampered));
  expect(refusal.code).toBe("unauthorized");
  await expect(verifier.verify(request)).resolves.toBeUndefined();
});

test("a signature is bound to the connection, the seq, the path, and the method", async () => {
  const pair = generateControlPlaneKey();
  const verifier = verifierFor([pair]);
  const request = signed(pair, "{}");
  const changes: readonly VerifiableRequest[] = [
    { ...request, headers: { ...request.headers, connection: "connection-2" } },
    { ...request, headers: { ...request.headers, seq: "2" } },
    { ...request, path: "/other" },
    { ...request, method: "PUT" },
  ];
  for (const changed of changes) {
    const refusal = await refusalOf(verifier.verify(changed));
    expect(refusal.code).toBe("unauthorized");
  }
});

test("a request that names another machine is refused", async () => {
  const pair = generateControlPlaneKey();
  const verifier = verifierFor([pair]);
  const request = signed(pair, "{}");
  const renamed: VerifiableRequest = {
    ...request,
    headers: { ...request.headers, machineId: "machine-2" },
  };
  const refusal = await refusalOf(verifier.verify(renamed));
  expect(refusal.code).toBe("unauthorized");
});

test("an empty enrollment or a malformed key is refused", async () => {
  const pair = generateControlPlaneKey();
  const request = signed(pair, "{}");
  expect((await refusalOf(verifierFor([]).verify(request))).code).toBe("unauthorized");
  const short: ControlPlaneKeyPair = { ...pair, publicKey: new Uint8Array(31) };
  expect((await refusalOf(verifierFor([short]).verify(request))).code).toBe("unauthorized");
});

test("a signature verifies only under the enrolled control-plane key", () => {
  const pair = generateControlPlaneKey();
  const other = generateControlPlaneKey();
  const request = signed(pair, "{}");
  const input = {
    machineId: request.headers.machineId,
    connection: request.headers.connection,
    seq: request.headers.seq,
    timestamp: request.headers.timestamp,
    nonce: request.headers.nonce,
    method: request.method,
    path: request.path,
    bodyHash: bodyHash(request.body),
  };
  expect(
    verifyRequestSignature(input, verificationKey(pair.publicKey), request.headers.signature),
  ).toBe(true);
  expect(
    verifyRequestSignature(input, verificationKey(other.publicKey), request.headers.signature),
  ).toBe(false);
  expect(verifyRequestSignature(input, verificationKey(pair.publicKey), "A".repeat(86))).toBe(
    false,
  );
});

test("either key in a rotation is accepted", async () => {
  const oldKey = generateControlPlaneKey();
  const newKey = generateControlPlaneKey();
  const foreign = generateControlPlaneKey();
  const verifier = verifierFor([oldKey, newKey]);
  await expect(
    verifier.verify(signed(oldKey, "{}", { nonce: "rotation-old-nonce" })),
  ).resolves.toBeUndefined();
  await expect(
    verifier.verify(signed(newKey, "{}", { nonce: "rotation-new-nonce" })),
  ).resolves.toBeUndefined();
  const refusal = await refusalOf(
    verifier.verify(signed(foreign, "{}", { nonce: "rotation-foreign-nonce" })),
  );
  expect(refusal.code).toBe("unauthorized");
});

test("a nonce is remembered until its window closes", () => {
  const cache = new NonceCache();
  expect(cache.accept("nonce-0123456789abcdef", NOW + WINDOW_MS, NOW)).toBe(true);
  expect(cache.accept("nonce-0123456789abcdef", NOW + WINDOW_MS, NOW + WINDOW_MS - 1)).toBe(false);
  expect(cache.accept("nonce-0123456789abcdef", NOW + WINDOW_MS, NOW + WINDOW_MS)).toBe(true);
  expect(cache.size).toBe(1);
});
