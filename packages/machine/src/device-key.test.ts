import { expect, test } from "vitest";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { readDeviceKey } from "./device-key.ts";

const privatePem = (): string => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const exported = privateKey.export({ format: "pem", type: "pkcs8" });
  return exported.toString();
};

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "hns-machine-key-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a device key with mode 0600 is loaded", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "device.pem");
    await writeFile(path, privatePem(), { mode: 0o600 });
    const key = await readDeviceKey(path);
    expect(key.asymmetricKeyType).toBe("ed25519");
  });
});

test("a key readable by group or other is refused", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "device.pem");
    await writeFile(path, privatePem());
    await chmod(path, 0o644);
    await expect(readDeviceKey(path)).rejects.toThrow(/0600/);
    await chmod(path, 0o640);
    await expect(readDeviceKey(path)).rejects.toThrow(/0600/);
  });
});

test("a symbolic link is not followed", async () => {
  await withDirectory(async (directory) => {
    const keyPath = join(directory, "device.pem");
    await writeFile(keyPath, privatePem(), { mode: 0o600 });
    const linkPath = join(directory, "device-link.pem");
    await symlink(keyPath, linkPath);
    await expect(readDeviceKey(linkPath)).rejects.toThrow(/symbolic link/);
  });
});

test("a key that is not Ed25519 is refused", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "rsa.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await writeFile(path, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    await expect(readDeviceKey(path)).rejects.toThrow(/Ed25519/);
  });
});
