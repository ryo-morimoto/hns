// Requirement 14: PRF wraps plus a recovery code; both open the same data key.
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

const base = await mkdtemp(join(tmpdir(), "hns-prf-"));
const stateDir = join(base, "state");
const root = join(base, "root");
const home = join(base, "home");
await mkdir(stateDir); await mkdir(root); await mkdir(home);
const webDirs = [join(import.meta.dirname, "ui"), join(import.meta.dirname, "../editor")];

let app = await startApp({ stateDir, root, provider: "faux", auth: "passkey", fauxScript: [], webDirs });
const origin = () => app.url.replace("127.0.0.1", "localhost");

const browser = await chromium.launch({
  executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
  env: { ...process.env, HOME: home, XDG_CACHE_HOME: join(home, ".cache"), XDG_CONFIG_HOME: join(home, ".config") },
});
const context = await browser.newContext();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, hasPrf: true, isUserVerified: true, automaticPresenceSimulation: true },
});

// Register, capture the one-time recovery code, then sign in with the passkey.
await page.goto(origin() + "/login.html");
await page.fill("#login", "ryo");
await page.click("#register");
await page.waitForFunction(() => document.querySelector("#status").textContent.includes("registered"), undefined, { timeout: 15000 });
const code = (await page.textContent("#recovery")).split(":").pop().trim();
check(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){4}$/.test(code), "a recovery code is shown once", code);

await page.reload();
await page.fill("#login", "ryo");
await page.click("#signin");
await page.waitForURL(origin() + "/", { timeout: 15000 });
const me = await page.evaluate(async () => (await fetch("/api/me")).json());
check(me.unlocked === true && me.hasWrapped === true, "the passkey unlocks the data key", JSON.stringify(me));

const put = await page.evaluate(async () => (await fetch("/api/secrets/user/note", { method: "PUT", body: JSON.stringify({ value: "top-secret" }) })).status);
check(put === 200, "a user secret can be written while unlocked");
const got = await page.evaluate(async () => { const r = await fetch("/api/secrets/user/note"); return { status: r.status, body: await r.json() }; });
check(got.status === 200 && got.body.value === "top-secret", "and read back");

// Restart: session survives, the data key does not.
await app.close();
app = await startApp({ stateDir, root, provider: "faux", auth: "passkey", fauxScript: [], webDirs });
await page.goto(origin() + "/");
const locked = await page.evaluate(async () => {
  const me = await (await fetch("/api/me")).json();
  const secret = await fetch("/api/secrets/user/note");
  return { me, status: secret.status };
});
check(locked.me.user?.login === "ryo", "the session survives a restart");
check(locked.me.unlocked === false && locked.status === 423, "user secrets are locked after a restart", JSON.stringify(locked));

// A wrong recovery code is rejected.
await page.goto(origin() + "/login.html");
await page.fill("#login", "ryo");
await page.fill("#code", "AAAAA-AAAAA-AAAAA-AAAAA-AAAAA");
await page.click("#recover");
await page.waitForFunction(() => document.querySelector("#status").textContent.includes("error"), undefined, { timeout: 10000 });
check(true, "a wrong recovery code is rejected");

// The recovery code opens the same data key.
await page.fill("#code", code);
await page.click("#recover");
await page.waitForURL(origin() + "/", { timeout: 15000 });
const recovered = await page.evaluate(async () => {
  const me = await (await fetch("/api/me")).json();
  const secret = await fetch("/api/secrets/user/note");
  return { me, status: secret.status, body: await secret.json() };
});
check(recovered.me.unlocked === true, "the recovery code unlocks the session", JSON.stringify(recovered.me));
check(recovered.status === 200 && recovered.body.value === "top-secret", "the same secret is readable through recovery", JSON.stringify(recovered));

await browser.close();
await app.close();
await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);