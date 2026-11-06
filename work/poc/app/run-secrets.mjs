// User secrets are encrypted at rest and invisible to the automation path.
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
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

const userSecret = "user-only-value-1234";
const serviceSecret = "service-only-value-5678";
check((await api("/api/secrets/user/note", { method: "PUT", body: JSON.stringify({ value: userSecret }) })).status === 200, "user secret stored");
check((await api("/api/secrets/service/provider.test", { method: "PUT", body: JSON.stringify({ value: serviceSecret }) })).status === 200, "service secret stored");

const userList = await api("/api/secrets?scope=user");
check(userList.body.some((item) => item.name === "note") && JSON.stringify(userList.body).includes(userSecret) === false, "listing shows names, not values");
check((await api("/api/secrets/bogus/x", { method: "PUT", body: JSON.stringify({ value: "x" }) })).status === 400, "unknown scope rejected");

await app.close();

const control = openControlPlane(join(stateDir, "control.sqlite"));
const store = new SecretStore({ stateDir, control });
check(store.get("user", "note") === userSecret, "the value round-trips");
check(store.getService("note") === undefined, "automation path cannot read a user secret");
check(store.getService("provider.test") === serviceSecret, "automation path reads service secrets");

const dbBytes = await readFile(join(stateDir, "control.sqlite"));
check(dbBytes.includes(Buffer.from(userSecret)) === false && dbBytes.includes(Buffer.from(serviceSecret)) === false, "plaintext is not in the database file");
await control.close();

const again = await startApp({ stateDir, root, provider: "faux", auth: false, fauxScript: [], webDirs });
const after = await again.api;
const list = await (await fetch(again.url + "/api/secrets?scope=service")).json();
check(list.some((item) => item.name === "provider.test"), "secrets survive a restart");
await fetch(again.url + "/api/secrets/user/note", { method: "DELETE" });
const afterDelete = await (await fetch(again.url + "/api/secrets?scope=user")).json();
check(afterDelete.length === 0, "delete removes the secret");
await again.close();

await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
