import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createPrivateKey } from "node:crypto";
import type { KeyObject } from "node:crypto";

/**
 * Load the machine's Ed25519 device key from its file.
 *
 * @param path - The key file, outside ROOT and outside the agent's bash view.
 * @returns The private key, ready to sign with.
 * @throws {Error} When the file cannot be opened, is not a regular file, is a
 * symbolic link, is readable by group or other, or does not hold an Ed25519 key.
 *
 * @remarks
 * The private half never leaves the machine (D049): the D1 Machine record holds
 * only the public half. A key that anyone else can read is refused instead of
 * used, so a wrong mode is fixed rather than silently tolerated. The mode check
 * accepts owner read (0600 or stricter) and rejects every group and other bit.
 */
export async function readDeviceKey(path: string): Promise<KeyObject> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: Error) => {
      if ("code" in error && error.code === "ELOOP") {
        throw new Error(`${path}: the device key must not be a symbolic link`);
      }
      throw error;
    },
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${path}: the device key is not a regular file`);
    const mode = info.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `${path}: the device key is readable by group or other (mode ${mode.toString(8)}); use 0600`,
      );
    }
    const pem = await handle.readFile();
    const key = createPrivateKey({ key: pem, format: "pem" });
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error(`${path}: the device key is not an Ed25519 key`);
    }
    return key;
  } finally {
    await handle.close();
  }
}
