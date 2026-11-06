// Requirement 18: sandbox availability, git write guard, recovery throttling, SSH flags.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sshArguments } from "@earendil-works/pi-env";
import { startApp } from "./server.mjs";
import { detectSandbox } from "../workspace-core/sandbox.mjs";
import { openControlPlane } from "./db.mjs";

let pass = 0, fail = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const webDirs = [join(import.meta.dirname, "ui"), join(import.meta.dirname, "../editor")];

// Bubblewrap is found, or the reason is reported.
const detected = await detectSandbox();
check(typeof detected.available === "boolean" && (detected.available || detected.reason), "detectSandbox reports a verdict", JSON.stringify(detected));

const base = await mkdtemp(join(tmpdir(), "hns-safe-"));
await mkdir(join(base, "state")); await mkdir(join(base, "root"));

// Without bubblewrap, exec tools are not offered and health says why.
{
  const app = await startApp({ stateDir: join(base, "state"), root: join(base, "root"), provider: "faux", auth: false, fauxScript: [{ toolCall: "bash", arguments: { command: "echo hi" } }, { text: "done" }], webDirs, bwrap: "/nonexistent/bwrap" });
  const health = await (await fetch(app.url + "/api/health")).json();
  check(health.sandbox.available === false && health.sandbox.reason, "health reports the sandbox is unavailable", JSON.stringify(health.sandbox));
  await fetch(app.url + "/api/chat", { method: "POST", body: JSON.stringify({ message: "run" }) });
  await sleep(800);
  const state = await (await fetch(app.url + "/api/state")).json();
  const toolResults = state.messages.filter((message) => message.role === "tool");
  check(toolResults.length === 1 && String(toolResults[0].text).includes("not available"), "a missing bash tool is refused", JSON.stringify(toolResults));
  await app.close();
}

// Writes into .git are refused.
{
  const app = await startApp({ stateDir: join(base, "state2"), root: join(base, "root"), provider: "faux", auth: false, fauxScript: [], webDirs, bwrap: detected.bwrap });
  const denied = await fetch(app.url + "/api/file", { method: "PUT", body: JSON.stringify({ path: ".git/config", content: "x", expectedVersion: "absent", operationId: "g1" }) });
  check(denied.status === 403, "writing under .git is denied", String(denied.status));
  const normal = await fetch(app.url + "/api/file", { method: "PUT", body: JSON.stringify({ path: "ok.txt", content: "x", expectedVersion: "absent", operationId: "g2" }) });
  check(normal.status === 200, "a normal write still works");
  await app.close();
}

// Wrong recovery codes are throttled.
{
  const stateDir = join(base, "state3");
  await mkdir(stateDir, { recursive: true });
  const control = openControlPlane(join(stateDir, "control.sqlite"));
  const user = control.createUser("ryo");
  control.addUserKey({ userId: user.id, kind: "recovery", wrappedDek: Buffer.alloc(48).toString("base64"), iv: Buffer.alloc(12).toString("base64"), salt: Buffer.alloc(16).toString("base64") });
  await control.close();

  const app = await startApp({ stateDir, root: join(base, "root"), provider: "faux", auth: "passkey", fauxScript: [], webDirs, bwrap: detected.bwrap });
  const attempt = () => fetch(app.url + "/api/passkey/recovery", { method: "POST", body: JSON.stringify({ login: "ryo", code: "AAAAA-AAAAA-AAAAA-AAAAA-AAAAA" }) });
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await attempt()).status);
  check(statuses.slice(0, 5).every((status) => status === 401) && statuses[5] === 429, "repeated wrong recovery codes are throttled", JSON.stringify(statuses));
  await app.close();
}

// SSH runs without agent/forwarding, with strict host keys.
{
  const args = sshArguments({ host: "example", hostKeyAlias: "pi-env-example", knownHostsFile: "/tmp/known_hosts" });
  const text = args.join(" ");
  check(args.includes("-T") && args.includes("-a") && args.includes("-x"), "no tty, no agent, no X11");
  check(text.includes("BatchMode=yes") && text.includes("ForwardAgent=no") && text.includes("ClearAllForwardings=yes"), "no prompts and no forwarding");
  check(text.includes("StrictHostKeyChecking=yes") && text.includes('UserKnownHostsFile="/tmp/known_hosts"'), "strict host keys against our file");
  check(text.includes("GlobalKnownHostsFile=none") && text.includes("ControlMaster=no"), "no shared connections or system known hosts");
}

await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);