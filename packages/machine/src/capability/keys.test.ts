import { generateKeyPairSync } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { expect, test } from "vitest";
import { sha256Hex } from "@hns/core/capability";
import { enrolledGrantKeys, fetchControlPlaneKeys, grantKeyId } from "./keys.ts";

/**
 * The control-plane key a grant is verified with, and where the machine gets it (0225).
 *
 * @remarks
 * Phase 1's signer (0224) hashes the base64url of the raw public key and takes the first 32 hex
 * characters as `keyId`. Two places computing that id must not drift, so the fixture here signs
 * with `node:crypto`'s `KeyObject` — what the Worker's signer is built on — and the machine's lookup
 * must find it by the id the signer would put in a grant. The face's own bytes are read as a client
 * reads them: a body parsed strictly, and no key when the answer is not the one the contract names.
 */

/** The raw 32-byte public key of an Ed25519 `KeyObject`. */
function rawPublicKey(key: KeyObject): Uint8Array {
  const der = key.export({ format: "der", type: "spki" });
  return new Uint8Array(der.subarray(12));
}

/** One control-plane key pair. */
function controlPlaneKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, rawPublicKey: rawPublicKey(publicKey) };
}

/** Unpadded base64url of some bytes, the spelling `GET /api/machines/keys` serves. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** The issuer's `keyId` (0224's `grantSigner`): the machine must agree with it byte for byte. */
async function issuerKeyId(raw: Uint8Array): Promise<string> {
  return (await sha256Hex(JSON.stringify(toBase64Url(raw)))).slice(0, 32);
}

// The machine's fingerprint is the issuer's: a grant naming one id is found by the other.
test("the machine computes the same keyId as the issuer", async () => {
  for (let round = 0; round < 3; round += 1) {
    const raw = controlPlaneKeyPair().rawPublicKey;
    expect(await grantKeyId(raw)).toBe(await issuerKeyId(raw));
  }
  expect(await issuerKeyId(new Uint8Array(32).fill(1))).toHaveLength(32);
});

// A key that is 32 bytes signs a grant the machine verifies; the lookup names it by keyId.
test("an enrolled key is found by keyId and verifies with it", async () => {
  const key = controlPlaneKeyPair();
  const keyId = await grantKeyId(key.rawPublicKey);
  const keys = enrolledGrantKeys({ publicKeys: async () => [key.rawPublicKey] });
  const found = await keys.publicKey(keyId, "Ed25519");
  expect(found.ok).toBe(true);
  if (!found.ok) return;
  // The key imports as a non-extractable Ed25519 verify key.
  expect(found.key.algorithm.name).toBe("Ed25519");
  expect(found.key.usages).toStrictEqual(["verify"]);
});

// Rotation: two keys side by side, and the grant's keyId picks the right one.
test("a rotation lists both keys and the grant's keyId selects one", async () => {
  const older = controlPlaneKeyPair();
  const newer = controlPlaneKeyPair();
  const keys = enrolledGrantKeys({
    publicKeys: async () => [older.rawPublicKey, newer.rawPublicKey],
  });
  const newerId = await grantKeyId(newer.rawPublicKey);
  const found = await keys.publicKey(newerId, "Ed25519");
  expect(found.ok).toBe(true);
  // A key that was retired is not enrolled any more, and its id is refused.
  const retired = await grantKeyId(controlPlaneKeyPair().rawPublicKey);
  expect(await keys.publicKey(retired, "Ed25519")).toMatchObject({
    ok: false,
    code: "grant_invalid",
  });
});

// Fail closed: no keys at all, a corrupt key, and another algorithm.
test("a machine with no key for the grant, or only corrupt keys, refuses", async () => {
  const empty = enrolledGrantKeys({ publicKeys: async () => [] });
  expect(await empty.publicKey("a".repeat(32), "Ed25519")).toMatchObject({
    ok: false,
    code: "grant_invalid",
  });
  // A 31-byte key is not an Ed25519 key; no id it could have is accepted.
  const short = enrolledGrantKeys({ publicKeys: async () => [new Uint8Array(31).fill(2)] });
  expect(await short.publicKey("a".repeat(32), "Ed25519")).toMatchObject({
    ok: false,
    code: "grant_invalid",
  });
  // An enrollment that cannot be read is a refusal, not an empty trust set that verifies nothing.
  const broken = enrolledGrantKeys({
    publicKeys: async () => {
      throw new Error("the registry is down");
    },
  });
  expect(await broken.publicKey("a".repeat(32), "Ed25519")).toMatchObject({
    ok: false,
    code: "grant_invalid",
  });
});

// Phase 1 issues Ed25519 only: a grant of another algorithm is a mismatch, never a fallback.
test("another algorithm is grant_algorithm_mismatch", async () => {
  const key = controlPlaneKeyPair();
  const keys = enrolledGrantKeys({ publicKeys: async () => [key.rawPublicKey] });
  expect(await keys.publicKey(await grantKeyId(key.rawPublicKey), "ECDSA-P256")).toMatchObject({
    ok: false,
    code: "grant_algorithm_mismatch",
  });
});

/** A face that answers one body and status, and records the request it was given. */
function face(status: number, body: string) {
  const requests: Request[] = [];
  // SAFETY: `fetch`'s parameter list is the platform's; this double is handed to
  // `fetchControlPlaneKeys`, which calls it with a URL and an init — the pair the real `fetch` takes.
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(input, init));
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

// The enrollment path: the face's public keys become the machine's ControlPlaneKeys.
test("the key face's public keys become the enrolled keys", async () => {
  const key = controlPlaneKeyPair();
  const served = JSON.stringify({
    keys: [{ publicKey: toBase64Url(key.rawPublicKey), algorithm: "ed25519" }],
  });
  const servedFace = face(200, served);
  const result = await fetchControlPlaneKeys({
    url: "https://hns.example/api/machines/keys",
    fetch: servedFace.fetch,
    session: "session-token",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // The face is read with the session cookie the edge checks, and never with the key in the URL.
  const [request] = servedFace.requests;
  expect(request?.url).toBe("https://hns.example/api/machines/keys");
  expect(request?.headers.get("cookie")).toBe("hns_session=session-token");
  // The key that was served is the key the machine verifies a grant with.
  const keys = enrolledGrantKeys(result.keys);
  const found = await keys.publicKey(await issuerKeyId(key.rawPublicKey), "Ed25519");
  expect(found.ok).toBe(true);
});

// Fail closed at the face too: a bad status, a body that is not the list, and a bad key.
test("a key face that cannot be read yields no keys", async () => {
  const cases = [
    { status: 503, body: JSON.stringify({ type: "about:blank", status: 503 }) },
    { status: 401, body: JSON.stringify({}) },
    { status: 200, body: "not json" },
    { status: 200, body: JSON.stringify({ keys: "AA" }) },
    { status: 200, body: JSON.stringify({ keys: [{ publicKey: "AA", algorithm: "ed25519" }] }) },
    { status: 200, body: JSON.stringify({ keys: [{}] }) },
    {
      status: 200,
      body: JSON.stringify({
        keys: [{ publicKey: toBase64Url(new Uint8Array(32)), algorithm: "ecdsa" }],
      }),
    },
  ] as const;
  for (const item of cases) {
    const result = await fetchControlPlaneKeys({
      url: "https://hns.example/api/machines/keys",
      fetch: face(item.status, item.body).fetch,
      session: "session-token",
    });
    expect(result.ok, item.body).toBe(false);
  }
  // An unreachable face is the same answer.
  const offline = async (): Promise<Response> => {
    throw new Error("offline");
  };
  expect(
    await fetchControlPlaneKeys({
      url: "https://hns.example/api/machines/keys",
      fetch: offline,
      session: "session-token",
    }),
  ).toMatchObject({ ok: false, reason: "the key face could not be reached" });
});
