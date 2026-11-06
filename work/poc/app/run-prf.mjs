// Requirement 14: the PRF-derived key unlocks user secrets, only while signed in.
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { startApp } from "./server.mjs";

const CHROME = process.env.HNS_CHROME ?? "/nix/store/r0f9i35n3r7rng8162xih4c1dag0s1vw-chromium-156.0.8078.47/bin/chromium";
if (!existsSync(CHROME)) { console.log("SKIP: no chromium at " + CHROME); process.exit(0); }
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

const signIn = async (originUrl) => {
  await page.goto(originUrl + "/login.html");
  await page.fill("#login", "ryo");
  await page.click("#register");
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("registered"), undefined, { timeout: 15000 });
  await page.reload();
  await page.fill("#login", "ryo");
  await page.click("#signin");
  await page.waitForURL(originUrl + "/", { timeout: 15000 });
};

await signIn(origin());
const me = await page.evaluate(async () => (await fetch("/api/me")).json());
check(me.unlocked === true, "the session is unlocked after signing in", JSON.stringify(me));
check(me.hasWrapped === true, "a wrapped data key was stored at registration");

const put = await page.evaluate(async () => (await fetch("/api/secrets/user/note", { method: "PUT", body: JSON.stringify({ value: "top-secret" }) })).status);
check(put === 200, "a user secret can be written while unlocked", String(put));
const got = await page.evaluate(async () => { const r = await fetch("/api/secrets/user/note"); return { status: r.status, body: await r.json() }; });
check(got.status === 200 && got.body.value === "top-secret", "and read back", JSON.stringify(got));

// Restart: the session survives, but the data key does not.
await app.close();
app = await startApp({ stateDir, root, provider: "faux", auth: "passkey", fauxScript: [], webDirs });
await page.goto(origin() + "/");
const locked = await page.evaluate(async () => {
  const me = await (await fetch("/api/me")).json();
  const secret = await fetch("/api/secrets/user/note");
  return { me, status: secret.status };
});
check(locked.me.user?.login === "ryo", "the session survives a restart", JSON.stringify(locked.me));
check(locked.me.unlocked === false && locked.status === 423, "user secrets are locked after a restart", JSON.stringify(locked));

// Signing in again unlocks them with the same passwordless key.
await page.goto(origin() + "/login.html");
await page.fill("#login", "ryo");
await page.click("#signin");
await page.waitForURL(origin() + "/", { timeout: 15000 });
const again = await page.evaluate(async () => { const r = await fetch("/api/secrets/user/note"); return { status: r.status, body: await r.json() }; });
check(again.status === 200 && again.body.value === "top-secret", "signing in again decrypts the same secret", JSON.stringify(again));

await browser.close();
await app.close();
await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
