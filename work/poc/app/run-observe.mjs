// Requirement 17: request log, events, and metrics.
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

async function makeApp(options = {}) {
  const base = await mkdtemp(join(tmpdir(), "hns-obs-"));
  await mkdir(join(base, "state")); await mkdir(join(base, "root"));
  const app = await startApp({ stateDir: join(base, "state"), root: join(base, "root"), provider: "faux", fauxScript: [{ toolCall: "read_file", arguments: { path: "a.txt" } }, { text: "hi" }], webDirs, ...options });
  const call = async (path, opts) => { const response = await fetch(app.url + path, opts); return { status: response.status, body: await response.json().catch(() => ({})) }; };
  const cleanup = async () => { await app.close(); await rm(base, { recursive: true, force: true }); };
  return { app, call, cleanup };
}

{
  const { app, call, cleanup } = await makeApp({ auth: false });
  const okResponse = await fetch(app.url + "/api/state");
  check(okResponse.status === 200 && Boolean(okResponse.headers.get("x-request-id")), "responses carry a request id");

  await fetch(app.url + "/api/missing");
  await fetch(app.url + "/api/file", { method: "PUT", body: JSON.stringify({ path: "a.txt", content: "x", expectedVersion: "absent", operationId: "setup" }) });
  await fetch(app.url + "/api/chat", { method: "POST", body: JSON.stringify({ message: "hello" }) });
  await waitFor(async () => (await call("/api/events?limit=200")).body.some((event) => event.event === "chat.settled"));

  const events = (await call("/api/events?limit=200")).body;
  check(events.some((event) => event.event === "http" && event.status === 200), "http 200 is logged");
  check(events.some((event) => event.event === "http" && event.status === 404), "http 404 is logged");
  check(events.some((event) => event.event === "chat.submitted") && events.some((event) => event.event === "chat.settled"), "chat lifecycle is logged");
  const toolCall = events.find((event) => event.event === "tool.call");
  const toolResult = events.find((event) => event.event === "tool.result");
  check(toolCall?.detail?.tool === "read_file", "a tool call is logged", JSON.stringify(toolCall));
  check(toolResult?.detail?.tool === "read_file" && toolResult?.detail?.isError === false && typeof toolResult.duration_ms === "number", "a tool result is logged with its duration", JSON.stringify(toolResult));
  const responses = events.filter((event) => event.event === "agent.response");
  check(responses.length >= 2 && responses[0].detail?.model === "faux/faux-1", "agent responses are logged", JSON.stringify(responses.slice(0, 2)));
  check(events.every((event) => !JSON.stringify(event).includes("token=")), "query strings are not logged");

  const metrics = (await call("/api/metrics")).body;
  check(metrics.http.total >= 4, "request count is aggregated", JSON.stringify(metrics.http));
  check(metrics.http.byStatus.some((row) => row.status === 404 && row.count >= 1), "status counts are aggregated", JSON.stringify(metrics.http.byStatus));
  check(metrics.http.p95ms >= 0, "percentiles are computed");
  check(metrics.chats["chat.submitted"] >= 1, "chat submissions are counted", JSON.stringify(metrics.chats));
  check(metrics.tokensToday.turns >= 1, "usage feeds the metrics", JSON.stringify(metrics.tokensToday));
  check(metrics.toolCalls >= 1 && metrics.toolErrors === 0, "tool calls are aggregated", JSON.stringify({ calls: metrics.toolCalls, errors: metrics.toolErrors }));
  check(metrics.agentResponses >= 2, "agent turns are aggregated", String(metrics.agentResponses));
  await cleanup();
}

// Auth failures are observable too.
{
  const { app, call, cleanup } = await makeApp({ auth: true, fauxScript: [] });
  const denied = await fetch(app.url + "/api/state");
  check(denied.status === 401, "the request is denied");
  await sleep(100);
  const events = (await call("/api/events?limit=50", { headers: { authorization: "Bearer " + app.token } })).body;
  check(events.some((event) => event.status === 401), "the denial is logged", JSON.stringify(events.slice(0, 3)));
  await cleanup();
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);