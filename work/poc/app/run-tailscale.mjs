// Requirement 13: tailnet identity (whois) instead of a shared token.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./server.mjs";
import { createTailscaleVerifier, parseUsers } from "./tailscale.mjs";

let pass = 0, fail = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };

// Parse
check(parseUsers("a@x, b@y ,,").join("|") === "a@x|b@y", "user list parsing");

// Verifier with an injected whois.
{
  let calls = 0;
  const verifier = createTailscaleVerifier({ users: ["alice@example.com"], whois: async (ip) => { calls++; return ip === "100.1.2.3" ? "alice@example.com" : undefined; } });

  check((await verifier("127.0.0.1")).ok === false, "loopback is not trusted by default");
  check((await createTailscaleVerifier({ allowLocal: true })("127.0.0.1")).ok === true, "loopback can be allowed");

  const allowed = await verifier("100.1.2.3");
  check(allowed.ok === true && allowed.user === "alice@example.com", "an allowed tailnet user passes");
  check((await verifier("100.1.2.3")).ok === true && calls === 1, "whois is cached per address");
  check((await verifier("100.9.9.9")).ok === false, "an unknown node is denied");
  check((await createTailscaleVerifier({ users: ["bob@example.com"], whois: async () => "alice@example.com" })("100.1.2.3")).ok === false, "a user outside the list is denied");
  check((await createTailscaleVerifier({ whois: async () => undefined })("100.1.2.3")).ok === false, "a failed whois is denied");
}

// Integration: the whole API behind tailnet identity.
{
  const base = await mkdtemp(join(tmpdir(), "hns-ts-"));
  const stateDir = join(base, "state");
  const root = join(base, "root");
  await mkdir(stateDir); await mkdir(root);
  const webDirs = [join(import.meta.dirname, "ui"), join(import.meta.dirname, "../editor")];

  const open = await startApp({ stateDir, root, provider: "faux", auth: "tailscale", tailscale: { allowLocal: true }, fauxScript: [], webDirs });
  check((await fetch(open.url + "/api/state")).status === 200, "an allowed local caller passes");
  await open.close();

  const closed = await startApp({ stateDir, root, provider: "faux", auth: "tailscale", tailscale: { allowLocal: false, whois: async () => undefined }, fauxScript: [], webDirs });
  check((await fetch(closed.url + "/api/state")).status === 401, "a caller with no tailnet identity is rejected");
  await closed.close();

  await rm(base, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
