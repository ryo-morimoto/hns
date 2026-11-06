// At-rest secrets with two scopes: "user" (a person's) and "service" (automations).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const SCOPES = ["user", "service"];

export class SecretStore {
  #key;
  #control;
  constructor({ stateDir, control, keyPath = join(stateDir, "secrets.key") }) {
    this.#control = control;
    if (process.env.HNS_SECRETS_KEY) {
      this.#key = Buffer.from(process.env.HNS_SECRETS_KEY, "hex");
    } else if (existsSync(keyPath)) {
      this.#key = readFileSync(keyPath);
    } else {
      mkdirSync(dirname(keyPath), { recursive: true });
      this.#key = randomBytes(32);
      writeFileSync(keyPath, this.#key, { mode: 0o600 });
    }
    if (this.#key.length !== 32) throw new Error("secrets key must be 32 bytes");
  }

  put(scope, name, value) {
    if (!SCOPES.includes(scope)) throw new Error("unknown scope: " + scope);
    if (!name) throw new Error("name is required");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    this.#control.putSecret({
      scope, name,
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    });
    return { scope, name };
  }

  get(scope, name) {
    if (!SCOPES.includes(scope)) return undefined;
    const row = this.#control.getSecret(scope, name);
    if (!row) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(row.iv, "base64"));
    decipher.setAuthTag(Buffer.from(row.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }

  /** Automations and background work use this; "user" secrets are invisible to it. */
  getService(name) { return this.get("service", name); }

  list(scope) { return this.#control.listSecretNames(scope); }
  delete(scope, name) { this.#control.deleteSecret(scope, name); }
}
