// Recovery codes: a second wrap of the same data key, derived with PBKDF2.
import { createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

export const RECOVERY_ITERATIONS = 600_000;
export const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newRecoveryCode(groups = 5, size = 5) {
  const bytes = randomBytes(groups * size);
  const chars = Array.from(bytes, (value) => RECOVERY_ALPHABET[value % RECOVERY_ALPHABET.length]);
  return Array.from({ length: groups }, (_, index) => chars.slice(index * size, (index + 1) * size).join("")).join("-");
}

export function normalizeRecoveryCode(code) {
  return String(code ?? "").toUpperCase().replace(/[^A-Z2-9]/g, "");
}

export function deriveRecoveryKey(code, salt) {
  return pbkdf2Sync(normalizeRecoveryCode(code), Buffer.from(salt, "base64"), RECOVERY_ITERATIONS, 32, "sha256");
}
/** Open a recovery-wrapped data key; throws if the code is wrong. */
export function openRecovery({ code, salt, wrappedDek, iv }) {
  const key = deriveRecoveryKey(code, salt);
  const data = Buffer.from(wrappedDek, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
}
