// Requirement 15: usage, rate limits, turn timeout, abort, and a daily budget.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./server.mjs";

let pass = 0, fail = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() - started > timeoutMs) return undefined; await sleep(50); }
}
const webDirs = [join(import.meta.dirname, "ui"), join(import.meta.dirname, "../editor")];

async function makeApp({ script, limits }) {
  const base = await mkdtemp(join(tmpdir(), "hns-lim-"));
  await mkdir(join(base, "state")); await mkdir(join(base, "root"));
  const app = await startApp({ stateDir: join(base, "state"), root: join(base, "root"), provider: "faux", auth: false, fauxScript: script, webDirs, limits });
  const call = async (path, options) => { const response = await fetch(app.url + path, options); return { status: response.status, body: await response.json().catch(() => ({})) }; };
  const chat = (message) => call("/api/chat", { method: "POST", body: JSON.stringify({ message }) });
  const cleanup = async () => { await app.close(); await rm(base, { recursive: true, force: true }); };
  return { app, call, chat, cleanup, base };
}

// Usage is recorded after each turn.
{
  const { call, chat, cleanup } = await makeApp({ script: [{ text: "hello" }], limits: {} });
  await chat("hi");
  const usage = await waitFor(async () => { const u = await call("/api/usage"); return u.body.today.turns > 0 ? u.body : undefined; });
  check(usage !== undefined, "a turn is recorded in today's usage", JSON.stringify(usage));
  check(usage?.today.tokens > 0, "tokens are counted", JSON.stringify(usage?.today));
  check(usage && Object.keys(usage.session.models ?? {}).length > 0, "the session reports per-model usage");
  await cleanup();
}

// Rate limit.
{
  const { chat, cleanup } = await makeApp({ script: [{ text: "a" }, { text: "b" }, { text: "c" }], limits: { turnsPerMinute: 2 } });
  check((await chat("1")).status === 202, "first turn accepted");
  check((await chat("2")).status === 202, "second turn accepted");
  const third = await chat("3");
  check(third.status === 429 && third.body.retryAfterMs > 0, "third turn in a minute is rate limited", JSON.stringify(third));
  await cleanup();
}

// Turn timeout and explicit abort.
{
  const { call, chat, cleanup } = await makeApp({ script: [{ toolCall: "slow_tool", arguments: {} }, { text: "late" }], limits: { turnTimeoutMs: 300 } });
  await chat("slow");
  const idle = await waitFor(async () => { const state = await call("/api/state"); return state.body.tasks.length === 0 && state.body.messages.length > 0 ? state.body : undefined; }, 10000);
  check(idle !== undefined, "a turn past its timeout is stopped", JSON.stringify(idle?.tasks));
  check(!(idle?.messages ?? []).some((message) => message.text === "late"), "the aborted turn has no answer");
  await cleanup();
}
{
  const { call, chat, cleanup } = await makeApp({ script: [{ toolCall: "slow_tool", arguments: {} }, { text: "late" }], limits: {} });
  await chat("slow");
  const aborted = await call("/api/chat/abort", { method: "POST", body: JSON.stringify({}) });
  check(aborted.status === 202 && ["aborted", "already_placed", "settled"].includes(aborted.body.outcome), "abort accepts", JSON.stringify(aborted));
  const idle = await waitFor(async () => { const state = await call("/api/state"); return state.body.tasks.length === 0 ? state.body : undefined; }, 10000);
  check(idle !== undefined, "the run is idle after abort");
  await cleanup();
}

// Daily budget.
{
  const { chat, cleanup } = await makeApp({ script: [{ text: "a" }, { text: "b" }], limits: { dailyTokenBudget: 1 } });
  check((await chat("1")).status === 202, "the first turn fits the budget");
  const second = await waitFor(async () => { const result = await chat("2"); return result.status === 429 ? result : undefined; }, 10000);
  check(second !== undefined, "the next turn is stopped by the daily budget", JSON.stringify(second));
  await cleanup();
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
