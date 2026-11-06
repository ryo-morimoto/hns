// Requirement 14: secret scopes. Service secrets are always readable; user secrets need an unlock.
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./server.mjs";
import { SecretStore } from "./secrets.mjs";
import { openControlPlane } from "./db.mjs";

let pass = 0, fail = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };

const base = await mkdtemp(join(tmpdir(), "hns-sec-"));
const stateDir = join(base, "state");
const root = join(base, "root");
await mkdir(stateDir); await mkdir(root);
const webDirs = [join(import.meta.dirname, "ui"), join(import.meta.dirname, "../editor")];
const app = await startApp({ stateDir, root, provider: "faux", auth: false, fauxScript: [], webDirs });
const api = async (path, options) => {
  const response = await fetch(app.url + path, options);
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

const serviceSecret = "service-only-value-5678";
check((await api("/api/secrets/service/provider.test", { method: "PUT", body: JSON.stringify({ value: serviceSecret }) })).status === 200, "service secret stored");
check((await api("/api/secrets/service/provider.test")).body.value === serviceSecret, "service secret read back");
check((await api("/api/secrets/user/note", { method: "PUT", body: JSON.stringify({ value: "x" }) })).status === 423, "a user secret cannot be written without an unlock");
check((await api("/api/secrets/bogus/x", { method: "PUT", body: JSON.stringify({ value: "x" }) })).status === 400, "unknown scope rejected");
check((await api("/api/secrets?scope=service")).body.some((item) => item.name === "provider.test"), "listing shows names");

await app.close();

// The store itself enforces the split.
const control = openControlPlane(join(stateDir, "control.sqlite"));
const store = new SecretStore({ stateDir, control });
const userKey = randomBytes(32);
store.put("user", "note", "user-only-value", { key: userKey });
check(store.get("user", "note", { key: userKey }) === "user-only-value", "a user secret round-trips with its key");
check(store.getService("note") === undefined, "the automation path cannot read a user secret");
check(store.getService("provider.test") === serviceSecret, "the automation path reads service secrets");
let locked = false;
try { store.get("user", "note"); } catch { locked = true; }
check(locked, "reading a user secret without a key fails");

const bytes = await readFile(join(stateDir, "control.sqlite"));
check(!bytes.includes(Buffer.from("user-only-value")) && !bytes.includes(Buffer.from(serviceSecret)), "plaintext is not in the database file");
await control.close();

const again = await startApp({ stateDir, root, provider: "faux", auth: false, fauxScript: [], webDirs });
check((await (await fetch(again.url + "/api/secrets?scope=service")).json()).some((item) => item.name === "provider.test"), "secrets survive a restart");
await fetch(again.url + "/api/secrets/service/provider.test", { method: "DELETE" });
check((await (await fetch(again.url + "/api/secrets?scope=service")).json()).length === 0, "delete removes the secret");
await again.close();

await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
