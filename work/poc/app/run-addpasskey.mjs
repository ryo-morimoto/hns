// Requirement 14: add a second passkey and keep the same data key.
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { startApp } from "./server.mjs";

function findChrome() {
  if (process.env.HNS_CHROME) return process.env.HNS_CHROME;
  try {
    const dirs = readdirSync("/nix/store").filter((name) => /-chromium-\d+\./.test(name)).sort().reverse();
    for (const dir of dirs) { const candidate = "/nix/store/" + dir + "/bin/chromium"; if (existsSync(candidate)) return candidate; }
  } catch {}
  return undefined;
}
const CHROME = findChrome();
if (!CHROME) { console.log("SKIP: no chromium"); process.exit(0); }
let pass = 0, fail = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };

const base = await mkdtemp(join(tmpdir(), "hns-add-"));
const stateDir = join(base, "state");
const root = join(base, "root");
const home = join(base, "home");
await mkdir(stateDir); await mkdir(root); await mkdir(home);
const webDirs = [join(import.meta.dirname, "ui"), join(import.meta.dirname, "../editor")];
const app = await startApp({ stateDir, root, provider: "faux", auth: "passkey", fauxScript: [], webDirs });
const origin = app.url.replace("127.0.0.1", "localhost");

const browser = await chromium.launch({
  executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
  env: { ...process.env, HOME: home, XDG_CACHE_HOME: join(home, ".cache"), XDG_CONFIG_HOME: join(home, ".config") },
});
const context = await browser.newContext();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, hasPrf: true, isUserVerified: true, automaticPresenceSimulation: true },
});
const credentials = async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;

// Register and sign in.
await page.goto(origin + "/login.html");
await page.fill("#login", "ryo");
await page.click("#register");
await page.waitForFunction(() => document.querySelector("#status").textContent.includes("registered"), undefined, { timeout: 15000 });
await page.reload();
await page.fill("#login", "ryo");
await page.click("#signin");
await page.waitForURL(origin + "/", { timeout: 15000 });
check((await credentials()).length === 1, "one credential after registration");

await page.evaluate(async () => { await fetch("/api/secrets/user/note", { method: "PUT", body: JSON.stringify({ value: "shared-secret" }) }); });

// A second device has no copy of the first credential; the first wrap stays on the server.
const first = (await credentials())[0];
await cdp.send("WebAuthn.removeCredential", { authenticatorId, credentialId: first.credentialId });

await page.goto(origin + "/login.html");
await page.click("#addpasskey");
await page.waitForFunction(() => document.querySelector("#status").textContent.includes("added"), undefined, { timeout: 15000 });
const after = await credentials();
check(after.length === 1 && after[0].credentialId !== first.credentialId, "a second credential was created", JSON.stringify(after.map((c) => c.credentialId)));

// Sign in with the new credential only.
await page.evaluate(async () => { await fetch("/api/passkey/logout", { method: "POST" }); });
await page.reload();
await page.fill("#login", "ryo");
await page.click("#signin");
await page.waitForURL(origin + "/", { timeout: 15000 });
const state = await page.evaluate(async () => {
  const me = await (await fetch("/api/me")).json();
  const secret = await fetch("/api/secrets/user/note");
  return { me, status: secret.status, body: await secret.json() };
});
check(state.me.unlocked === true, "the new passkey unlocks the session", JSON.stringify(state.me));
check(state.status === 200 && state.body.value === "shared-secret", "the same secret is readable through the new passkey", JSON.stringify(state));

await browser.close();
await app.close();
await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);