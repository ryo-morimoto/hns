// Manual smoke test for the UI PoC. Starts the real app with faux, drives Chromium,
// and asserts the main flows. Skips when no Chromium is available.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { startApp } from "../server.mjs";

function findChromium() {
  if (process.env.HNS_CHROME) return process.env.HNS_CHROME;
  const candidates = [];
  for (const name of readdirSync("/nix/store")) {
    if (!/^[a-z0-9]+-chromium-\d/.test(name)) continue;
    const path = "/nix/store/" + name + "/bin/chromium";
    if (existsSync(path)) candidates.push(path);
  }
  return candidates.at(-1) ?? null;
}

const executablePath = findChromium();
if (!executablePath) {
  console.log("SKIP: Chromium not found (set HNS_CHROME)");
  process.exit(0);
}

const dir = await mkdtemp(join(tmpdir(), "hns-ui-smoke-"));
const root = join(dir, "root");
const stateDir = join(dir, "state");
let app;
let browser;
try {
  await mkdir(root + "/src", { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(root + "/README.md", "# smoke\n\nhello\n");
  await writeFile(root + "/src/example.ts", "export const answer = 42;\n");

  app = await startApp({
    stateDir,
    root,
    provider: "faux",
    auth: false,
    webDirs: [
      new URL("../ui/", import.meta.url).pathname,
      new URL("../../editor/", import.meta.url).pathname,
    ],
    fauxScript: [
      { text: "最初の応答です。" },
      { toolCall: "slow_tool", arguments: {} },
      { text: "中止されなかった場合の応答です。" },
    ],
  });

  browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text()); });

  await page.goto(app.url + "/", { waitUntil: "domcontentloaded" });
  await page.locator("#home-view").waitFor({ state: "visible" });
  await page.locator(".stat").first().waitFor({ state: "visible" });
  assert.match(page.url(), /#\/p\/default$/);
  assert.equal(await page.locator(".stat").count(), 3);
  assert.match(await page.locator("#home-view").innerText(), /まだ仕事はありません/);

  // A normal turn becomes a completed conversation on the workspace home.
  await page.click("#new-conversation");
  await page.locator("#composer-input").fill("こんにちは ");
  await page.locator("#composer-input").press("Enter");
  await page.waitForFunction(() => document.querySelector("#transcript")?.innerText.includes("最初の応答です。"));
  assert.equal(await page.locator("#composer-input").inputValue(), "", "a sent message with trailing whitespace is cleared");
  const messages = await page.locator("#transcript .msg").allInnerTexts();
  assert.ok(messages[0].includes("あなた"), "the user message comes first");
  await page.click("#home-btn");
  await page.locator("#home-view").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelectorAll("#home-view .work-card.completed").length > 0);

  // A draft survives visiting the workspace and coming back.
  await page.locator("#home-view .work-card.completed button", { hasText: "開く" }).first().click();
  await page.locator("#conversation-view").waitFor({ state: "visible" });
  await page.locator("#composer-input").fill("下書き");
  await page.click("#home-btn");
  await page.locator("#home-view").waitFor({ state: "visible" });
  await page.locator("#home-view .work-card.completed button", { hasText: "開く" }).first().click();
  await page.locator("#conversation-view").waitFor({ state: "visible" });
  assert.equal(await page.locator("#composer-input").inputValue(), "下書き");
  await page.locator("#composer-input").fill("");
  await page.click("#home-btn");
  await page.locator("#home-view").waitFor({ state: "visible" });

  // An aborted turn moves to Needs you.
  await page.click("#new-conversation");
  await page.locator("#composer-input").fill("時間のかかる作業");
  await page.locator("#composer-input").press("Enter");
  await page.locator("#stop-btn").waitFor({ state: "visible" });
  assert.match(await page.title(), /^\(1\)/, "running work is visible in the tab");
  assert.equal((await page.locator("#progress").innerText()).includes("pi."), false, "internal task kinds are not shown");
  await page.click("#stop-btn");
  await page.waitForFunction(() => document.querySelector("#transcript")?.innerText.includes("中断されました"));
  await page.locator("#stop-btn").waitFor({ state: "hidden" });
  await page.click("#home-btn");
  await page.locator("#home-view").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#home-view")?.innerText.includes("中断されました"));

  // Acknowledgement clears the attention card; Undo restores it.
  const abortedCard = page.locator("#home-view .work-card.needs").filter({ hasText: "中断されました" });
  await abortedCard.locator("button", { hasText: "確認済み" }).click();
  await page.waitForFunction(() => !document.querySelector("#home-view")?.innerText.includes("中断されました"));
  await page.locator(".toast-action", { hasText: "元に戻す" }).last().click();
  await page.waitForFunction(() => document.querySelector("#home-view")?.innerText.includes("中断されました"));

  // J moves focus between work cards.
  await page.locator(".work-card").first().focus();
  await page.keyboard.press("j");
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("work-card")), true);

  // Project task: add and complete from the sidebar.
  await page.click("#add-task");
  await page.locator("#task-input").fill("スモーク用タスク");
  await page.locator("#task-input").press("Enter");
  await page.locator(".task").filter({ hasText: "スモーク用タスク" }).waitFor({ state: "visible" });
  await page.locator(".task").filter({ hasText: "スモーク用タスク" }).locator(".task-status").click();
  await page.locator(".menu-item", { hasText: "完了" }).click();
  await page.locator(".task.done").filter({ hasText: "スモーク用タスク" }).waitFor({ state: "visible" });

  // Editor: open, edit, save, diff.
  await page.locator("#home-btn").click();
  await page.locator("#home-view").waitFor({ state: "visible" });
  await page.locator(".work-card.completed button", { hasText: "開く" }).first().click();
  await page.locator("#conversation-view").waitFor({ state: "visible" });
  await page.click("#editor-toggle");
  await page.locator(".editor-panel.open").waitFor({ state: "visible" });
  await page.locator(".file-item").filter({ hasText: "README.md" }).first().click();
  await page.locator(".editor-text").waitFor({ state: "visible" });
  await page.locator(".editor-text").fill("# smoke\n\nchanged from the smoke test\n");
  await page.locator(".editor-actions button", { hasText: "保存" }).click();
  await page.locator(".toast-text", { hasText: "保存しました" }).waitFor({ state: "visible" });
  await page.locator(".editor-text").fill("# smoke\n\nchanged again for the diff\n");
  await page.locator(".editor-actions button", { hasText: "差分" }).click();
  await page.locator(".diff-line").first().waitFor({ state: "visible" });

  // Home navigation discards the unsaved editor buffer after confirmation.
  await page.click("#home-btn");
  const discard = page.locator("#modal button", { hasText: "破棄して移動" });
  await discard.waitFor({ state: "visible" });
  await discard.click();
  await page.locator("#home-view").waitFor({ state: "visible" });
  assert.equal(await page.locator("#editor-panel").isVisible(), false, "the editor closes after discard");

  // Palette.
  await page.keyboard.press("Control+k");
  await page.locator("#palette").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.locator("#home-view").waitFor({ state: "visible" });

  // A malformed hash is a bad link, not a broken router.
  await page.goto(app.url + "/#/p/%", { waitUntil: "domcontentloaded" });
  await page.locator("#home-view").waitFor({ state: "visible" });
  assert.match(page.url(), /#\/p\/default$/);

  // Mobile: the sidebar scrim visible and an outside tap closes it.
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(app.url + "/", { waitUntil: "domcontentloaded" });
  await mobile.locator("#home-view").waitFor({ state: "visible" });
  await mobile.click("#sidebar-toggle");
  await mobile.waitForTimeout(300);
  assert.equal(await mobile.locator(".app").evaluate((node) => node.classList.contains("sidebar-open")), true);
  const scrimOpacity = await mobile.locator("#backdrop").evaluate((node) => getComputedStyle(node).opacity);
  assert.notEqual(scrimOpacity, "0", "the sidebar scrim is visible");
  await mobile.mouse.click(350, 400);
  await mobile.waitForFunction(() => !document.querySelector(".app").classList.contains("sidebar-open"));

  assert.deepEqual(errors, [], "no page errors");
  console.log("PASS ui-smoke");
} finally {
  if (browser) await browser.close().catch(() => {});
  if (app) await app.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
