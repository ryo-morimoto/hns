// Requirement 13: passkey registration/login through a virtual authenticator (Playwright + CDP).
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const base = await mkdtemp(join(tmpdir(), "hns-pk-"));
const stateDir = join(base, "state");
const root = join(base, "root");
const home = join(base, "home");
await mkdir(stateDir); await mkdir(root); await mkdir(home);
const webDirs = [join(import.meta.dirname, "ui"), join(import.meta.dirname, "../editor")];
const app = await startApp({ stateDir, root, provider: "faux", auth: "passkey", fauxScript: [{ text: "x" }], webDirs });
const pageOrigin = app.url.replace("127.0.0.1", "localhost");

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  env: { ...process.env, HOME: home, XDG_CACHE_HOME: join(home, ".cache"), XDG_CONFIG_HOME: join(home, ".config") },
});
const context = await browser.newContext();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

await page.goto(pageOrigin + "/login.html");
await page.fill("#login", "ryo");
await page.click("#register");
await page.waitForFunction(() => document.querySelector("#status").textContent.includes("registered"), undefined, { timeout: 15000 });
check(true, "passkey registration succeeds");

check((await page.evaluate(async () => (await fetch("/api/state")).status)) === 401, "the API is closed before sign-in");

await page.reload();
await page.fill("#login", "ryo");
await page.click("#signin");
await page.waitForURL(pageOrigin + "/", { timeout: 15000 });
check(true, "passkey login redirects to the app");
const me = await page.evaluate(async () => (await fetch("/api/me")).json());
check(me.user?.login === "ryo", "the session identifies the user", JSON.stringify(me));
check(me.hasWrapped === true && me.unlocked === false, "an authenticator without PRF registers (recovery wrap only) and stays locked", JSON.stringify(me));
check((await page.evaluate(async () => (await fetch("/api/state")).status)) === 200, "the session opens the API");

// No cookie at all.
check((await fetch(pageOrigin + "/api/state")).status === 401, "a caller without a session has no access");

await browser.close();
await app.close();
await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);