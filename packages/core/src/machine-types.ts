import * as v from "valibot";
import { BASE64URL_ALPHABET, type IsoTimestamp } from "./codecs.ts";

/**
 * The machine registry's model: a registered machine, the device key it signs with, and the
 * two observations that decide whether the Worker can reach it.
 *
 * @remarks
 * The registry is D1 rows plus a fetch (D049): there is no Durable Object holding a connection,
 * because `cloudflared` keeps the outbound tunnel and the machine's state is a row. The issue is
 * 0148; the decision is D087.
 *
 * **Two directions, two keys, and neither secret here.** A machine signs its own requests
 * (machine → Worker) with its **device key**; only the raw 32-byte public half is stored, in
 * {@link Machine.publicKey}. The Worker signs its requests to the machine with the
 * **control-plane key**, whose private half is a Worker secret and whose public half the machine
 * receives at enrollment; this model never carries that private half either.
 *
 * **Stored state versus observation.** {@link MachineStatus} is the decision a person made
 * (`revoked`) or the reachability the registry last recorded (`online` / `offline`).
 * `reachable` and `lastSeen` are observations: a probe's answer and when the machine was last
 * seen. A revoked machine is terminal and its key is never handed out again, which is what makes
 * revocation immediate: the next signed request has no key to verify against and is refused
 * closed.
 */

/**
 * The closed machine status vocabulary.
 *
 * @remarks
 * `revoked` is **terminal**: a revoked machine's name cannot be enrolled again (a reimaged
 * machine takes a new name), and the registry returns no key for it. Adding a member requires
 * updating every exhaustive `switch` over `MachineStatus`.
 */
export const MACHINE_STATUSES = ["online", "offline", "revoked"] as const;

/** One machine status; `revoked` is terminal. */
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

/** Bytes in a raw Ed25519 public key; the only length a device key may have. */
export const ED25519_PUBLIC_KEY_BYTES = 32;

/** The signature algorithm a device key must be; the column holds nothing else. */
export const DEVICE_KEY_ALGORITHM = "ed25519" as const;

/** One algorithm a device key may name. */
export type DeviceKeyAlgorithm = typeof DEVICE_KEY_ALGORITHM;

/** Hex characters in a device key's SHA-256 fingerprint. */
export const DEVICE_KEY_FINGERPRINT_HEX_LENGTH = 32;

/**
 * The prefix every device key fingerprint carries, so a pasted value names what it is.
 *
 * @remarks
 * The fingerprint is the **first 16 bytes** of the SHA-256 of the raw public key, in lowercase
 * hex: short enough for a person to compare on screen, long enough that a different key cannot
 * collide with it in practice. It is not the key; it may be shown and copied.
 */
export const DEVICE_KEY_FINGERPRINT_PREFIX = "ed25519:";

/** A device key fingerprint: `ed25519:` followed by 32 lowercase hex characters. */
export const DEVICE_KEY_FINGERPRINT_MAX = DEVICE_KEY_FINGERPRINT_PREFIX.length + 32;

/** The canonical device key fingerprint schema; anything else is not a fingerprint. */
export const DeviceKeyFingerprintSchema = v.pipe(v.string(), v.regex(/^ed25519:[0-9a-f]{32}$/u));

/** A device key fingerprint, the value a person compares between the machine and the browser. */
export type DeviceKeyFingerprint = string;

/** A device key in the model's spelling: base64url, no padding, 43 characters for 32 bytes. */
export const DEVICE_KEY_BASE64URL_PATTERN = new RegExp("^[" + BASE64URL_ALPHABET + "]{43}$", "u");

/**
 * Encode a raw Ed25519 public key as base64url, the model's spelling.
 *
 * @param publicKey - The raw 32-byte key.
 * @returns 43 base64url characters without padding.
 * @throws Error when the key is not exactly 32 bytes.
 */
export function encodeDeviceKey(publicKey: Uint8Array): string {
  if (publicKey.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error("a device key is not a 32-byte Ed25519 key");
  }
  let binary = "";
  for (const byte of publicKey) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/**
 * Decode a device key in the model's spelling back to its raw bytes.
 *
 * @param text - 43 base64url characters, as {@link Machine.publicKey} holds them.
 * @returns The raw 32-byte key.
 * @throws Error when the text is not base64url of exactly 32 bytes.
 */
export function decodeDeviceKey(text: string): Uint8Array<ArrayBuffer> {
  if (!DEVICE_KEY_BASE64URL_PATTERN.test(text)) {
    throw new Error("a device key is not base64url of a 32-byte Ed25519 key");
  }
  const padded = text.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error("a device key is not base64url of a 32-byte Ed25519 key");
  }
  return bytes;
}

/**
 * The SHA-256 fingerprint of a raw Ed25519 public key.
 *
 * @param publicKey - The raw 32-byte key.
 * @returns `ed25519:` and the first 16 bytes of its SHA-256, in lowercase hex.
 * @throws Error when the key is not exactly 32 bytes: a fingerprint of a malformed key would let
 * two different mistakes compare equal.
 *
 * @remarks
 * WebCrypto only: the registry and the machine both compute it, and the machine is a Node process
 * while the edge is workerd. `crypto.subtle.digest` exists on both.
 */
export async function deviceKeyFingerprint(publicKey: Uint8Array): Promise<DeviceKeyFingerprint> {
  if (publicKey.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error("a device key is not a 32-byte Ed25519 key");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(publicKey)));
  let hex = "";
  for (const byte of digest.subarray(0, DEVICE_KEY_FINGERPRINT_HEX_LENGTH / 2)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return DEVICE_KEY_FINGERPRINT_PREFIX + hex;
}

/**
 * One registered machine.
 *
 * @remarks
 * `name` is unique and is what a person types; `hostname` is the tunnel host the Worker fetches
 * through. There is no ROOT here: the Workspace object's first acquire binds the machine id to a
 * root, and the root is local configuration (D080). There is no secret here: the device key's
 * private half never leaves the machine and the control-plane key's private half is a Worker
 * secret (D100).
 */
export interface Machine {
  /** The id the Worker names in a machine request; immutable, so a reimage keeps it. */
  readonly id: string;
  /** The unique display name a person registers with; a reimage keeps it. */
  readonly name: string;
  /** The tunnel hostname the Worker fetches the machine through. */
  readonly hostname: string;
  /**
   * The device key's public half, base64url without padding.
   *
   * @remarks
   * The public half **is** the model value, in the spelling a browser and the machine show, so the
   * GraphQL type and an enrollment can carry it without a second representation. It is a public
   * key: the private half never leaves the machine. The store converts to and from the BLOB column
   * `machines.public_key` at its boundary.
   */
  readonly publicKey: string;
  /** The algorithm the key must be; `ed25519`, checked at the schema and the column. */
  readonly keyAlgorithm: DeviceKeyAlgorithm;
  /** The first 16 bytes of the key's SHA-256, `ed25519:<hex>`; the value a person compares. */
  readonly fingerprint: DeviceKeyFingerprint;
  /** The agent version the machine enrolled with, for the operator. */
  readonly agentVersion: string;
  /** When the machine was last seen, in epoch milliseconds, or null before the first probe. */
  readonly lastSeen: number | null;
  /** The stored status; `revoked` is terminal. */
  readonly status: MachineStatus;
  /** When the row was created. */
  readonly createdAt: IsoTimestamp;
  /** When the row last changed. */
  readonly updatedAt: IsoTimestamp;
}

/**
 * What the registry refuses, as a closed vocabulary.
 *
 * @remarks
 * Each is an expected answer the face maps to one union member; none is a defect.
 */
export const MACHINE_REGISTRY_REFUSALS = [
  /** Another row already has this name and it is not a reimage. */
  "name_taken",
  /** The name belongs to a revoked machine; a new machine needs a new name. */
  "revoked",
  /** The machine id names no row. */
  "not_found",
  /** The input is not a device key, a name, or a host that the model accepts. */
  "invalid_request",
] as const;

/** One reason the registry refused a write. */
export type MachineRegistryRefusal = (typeof MACHINE_REGISTRY_REFUSALS)[number];

/**
 * What a registration asks for.
 *
 * @remarks
 * `publicKey` is the device key's public half in the model's base64url spelling: it is what the
 * machine displayed and a person pasted, and it is not a secret. The name is the identity a person
 * chooses; the machine id is generated here and is what the Worker names forever after.
 */
export interface MachineEnrollment {
  readonly name: string;
  readonly hostname: string;
  /** The device key's public half, base64url without padding. */
  readonly publicKey: string;
  readonly agentVersion: string;
}

/** What one registration did. */
export type MachineRegistration =
  | {
      readonly kind: "enrolled";
      readonly machine: Machine;
    }
  | {
      /** The name already existed with a different key: the key was replaced as a reimage. */
      readonly kind: "reimaged";
      readonly machine: Machine;
      /** The fingerprint of the key that was replaced; the old key is unusable from now on. */
      readonly previousFingerprint: DeviceKeyFingerprint;
    };

/**
 * The name rules a machine's name uses.
 *
 * @remarks
 * Lowercase letters, digits, and `-`, starting and ending with a letter or digit: the same shape
 * as the tunnel's hostname label, so a name can be typed and compared without ambiguity.
 */
export const MACHINE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

/** The hostname rules: a DNS name the tunnel answers on, without a scheme or a path. */
export const MACHINE_HOSTNAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

/** The longest agent version string the registry keeps. */
export const MAX_AGENT_VERSION_LENGTH = 64;

/**
 * Parse a registration into its stored parts.
 *
 * @returns The name, the hostname, the key in the model's base64url spelling, and the agent version.
 * @throws {v.ValiError} when any part is not the shape the registry stores. Nothing is written.
 *
 * @remarks
 * This is the boundary check: a browser sends the values it was shown, and a value that is not a
 * 32-byte device key, a name, or a hostname is refused here rather than stored.
 */
export function parseMachineEnrollment(input: {
  readonly name: string;
  readonly hostname: string;
  readonly publicKey: string;
  readonly agentVersion: string;
}): MachineEnrollment {
  return v.parse(
    v.object({
      name: v.pipe(
        v.string(),
        v.trim(),
        v.regex(MACHINE_NAME_PATTERN, "a machine name is lowercase letters, digits, and -"),
      ),
      hostname: v.pipe(
        v.string(),
        v.trim(),
        v.maxLength(253),
        v.regex(MACHINE_HOSTNAME_PATTERN, "a machine hostname is a DNS name"),
      ),
      publicKey: v.pipe(
        v.string(),
        v.regex(
          DEVICE_KEY_BASE64URL_PATTERN,
          "a device key is base64url of a 32-byte Ed25519 public key",
        ),
      ),
      agentVersion: v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1),
        v.maxLength(MAX_AGENT_VERSION_LENGTH),
      ),
    }),
    input,
  );
}
