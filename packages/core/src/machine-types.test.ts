import { expect, test } from "vitest";
import * as v from "valibot";
import {
  DEVICE_KEY_FINGERPRINT_MAX,
  DeviceKeyFingerprintSchema,
  MACHINE_HOSTNAME_PATTERN,
  MACHINE_NAME_PATTERN,
  MACHINE_STATUSES,
  decodeDeviceKey,
  deviceKeyFingerprint,
  encodeDeviceKey,
  parseMachineEnrollment,
} from "./machine-types.ts";

/**
 * The machine registry's model (0148 / D087).
 *
 * @remarks
 * These pin the parts a caller can get wrong at the boundary: the key's spelling and length, the
 * fingerprint's shape, the name and hostname rules, and the fact that no secret is part of the
 * model. The store and the face are tested where they live.
 */

/** A 32-byte seed, as the test's device key. */
function bytes(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

// Catches: a key spelling that does not round-trip, or that accepts the wrong length.
test("a device key round-trips through base64url and only 32 bytes are accepted", () => {
  const raw = bytes(1);
  const text = encodeDeviceKey(raw);
  expect(text).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(decodeDeviceKey(text)).toStrictEqual(raw);
  expect(() => encodeDeviceKey(new Uint8Array(31))).toThrow();
  expect(() => encodeDeviceKey(new Uint8Array(33))).toThrow();
  expect(() => decodeDeviceKey("short")).toThrow();
  expect(() => decodeDeviceKey(text + "A")).toThrow();
  expect(() => decodeDeviceKey("")).toThrow();
});

// Catches: a fingerprint that is not the raw bytes' SHA-256, or that is longer than a person
// can compare.
test("the fingerprint is ed25519: and the first 16 bytes of the SHA-256", async () => {
  const raw = bytes(2);
  const fingerprint = await deviceKeyFingerprint(raw);
  expect(fingerprint).toMatch(/^ed25519:[0-9a-f]{32}$/u);
  expect(fingerprint.length).toBe(DEVICE_KEY_FINGERPRINT_MAX);
  expect(v.safeParse(DeviceKeyFingerprintSchema, fingerprint).success).toBe(true);
  // The digest's first 16 bytes, computed here independently.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(raw)));
  // `Array.from`, not `Uint8Array.prototype.map`: the typed array's map returns bytes, so a hex
  // string per byte would be narrowed back to one byte.
  const expected = Array.from(digest.slice(0, 16))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  expect(fingerprint).toBe("ed25519:" + expected);
  // A different key gives a different fingerprint.
  expect(await deviceKeyFingerprint(bytes(3))).not.toBe(fingerprint);
  // A malformed key has no fingerprint at all.
  await expect(deviceKeyFingerprint(new Uint8Array(8))).rejects.toThrow();
});

// Catches: a fingerprint schema that accepts another algorithm or a malformed hex.
test.each([
  ["another algorithm", "rsa:00000000000000000000000000000000"],
  ["uppercase hex", "ed25519:0000000000000000000000000000000A"],
  ["too short", "ed25519:0"],
  ["no prefix", "0000000000000000000000000000000"],
])("a fingerprint that is not ed25519:<32 hex> is refused: %s", (_label, value) => {
  expect(v.safeParse(DeviceKeyFingerprintSchema, value).success).toBe(false);
});

// Catches: a name or hostname the tunnel could not carry, or a key of the wrong shape stored.
test("parseMachineEnrollment accepts a valid enrollment and refuses every malformed part", () => {
  const valid = {
    name: "laptop",
    hostname: "laptop.example.ts.net",
    publicKey: encodeDeviceKey(bytes(4)),
    agentVersion: "0.1.0",
  };
  expect(parseMachineEnrollment(valid).name).toBe("laptop");
  expect(parseMachineEnrollment({ ...valid, name: "  laptop  " }).name).toBe("laptop");
  for (const [name, bad] of [
    ["an uppercase name", { ...valid, name: "Laptop" }],
    ["an empty name", { ...valid, name: "" }],
    ["a name with a slash", { ...valid, name: "a/b" }],
    ["a hostname without a dot", { ...valid, hostname: "laptop" }],
    ["a hostname with a scheme", { ...valid, hostname: "https://laptop.example.ts.net" }],
    ["a hostname with a path", { ...valid, hostname: "laptop.example.ts.net/x" }],
    ["a short key", { ...valid, publicKey: "short" }],
    ["an empty agent version", { ...valid, agentVersion: "" }],
  ] as const) {
    expect(() => parseMachineEnrollment(bad), name).toThrow();
  }
});

// Catches: a name or hostname regex that accepts what the tunnel cannot carry.
test("the name and hostname patterns are the tunnel's shape", () => {
  for (const name of ["a", "laptop", "box-1", "a".repeat(64)]) {
    expect(MACHINE_NAME_PATTERN.test(name), name).toBe(true);
  }
  for (const name of ["", "-a", "a-", "A", "a b", "a".repeat(65)]) {
    expect(MACHINE_NAME_PATTERN.test(name), name).toBe(false);
  }
  expect(MACHINE_HOSTNAME_PATTERN.test("laptop.example.ts.net")).toBe(true);
  expect(MACHINE_HOSTNAME_PATTERN.test("laptop")).toBe(false);
});

// Catches: a status vocabulary that grows without the contract.
test("the status vocabulary is the contract's and revoked is terminal", () => {
  expect(MACHINE_STATUSES).toStrictEqual(["online", "offline", "revoked"]);
});

// Catches: a secret-like field creeping into the model.
test("the enrollment model carries no private key field", () => {
  const parsed = parseMachineEnrollment({
    name: "laptop",
    hostname: "laptop.example.ts.net",
    publicKey: encodeDeviceKey(bytes(5)),
    agentVersion: "0.1.0",
  });
  expect(Object.keys(parsed).sort()).toStrictEqual([
    "agentVersion",
    "hostname",
    "name",
    "publicKey",
  ]);
});
