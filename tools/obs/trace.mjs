#!/usr/bin/env node
/**
 * Trace one correlation id across the hops that logged it.
 *
 * Usage: HNS_URL=... HNS_SESSION_COOKIE=... node tools/obs/trace.mjs <requestId> [--expect <hop>]
 *
 * Reads GET /api/events?requestId=<id> (session auth) and prints the hops in time order. With
 * --expect, exits 1 when that hop is missing, naming the last hop that was observed.
 */

const HOPS = ["browser", "worker", "do", "agent", "fs"];

function usage() {
  process.stderr.write(
    "usage: HNS_URL=https://... HNS_SESSION_COOKIE=hns_session=... " +
      "node tools/obs/trace.mjs <requestId> [--expect <hop>]\n",
  );
}

function parseArgs(argv) {
  const positional = [];
  let expect;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--expect") {
      expect = argv[index + 1];
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  return { requestId: positional[0], expect };
}

function hopOrder(hop) {
  const index = HOPS.indexOf(hop);
  return index === -1 ? HOPS.length : index;
}

function text(value) {
  return value === undefined || value === null ? "-" : String(value);
}

async function main() {
  const { requestId, expect } = parseArgs(process.argv.slice(2));
  const base = process.env.HNS_URL;
  const cookie = process.env.HNS_SESSION_COOKIE;
  if (requestId === undefined || base === undefined || cookie === undefined) {
    usage();
    return 2;
  }
  if (expect !== undefined && !HOPS.includes(expect)) {
    process.stderr.write("hns-obs: --expect must be one of " + HOPS.join(", ") + "\n");
    return 2;
  }
  const url = new URL("/api/events", base);
  url.searchParams.set("requestId", requestId);
  url.searchParams.set("limit", "500");
  let response;
  try {
    response = await fetch(url, {
      headers: { cookie, "x-request-id": requestId },
      redirect: "error",
    });
  } catch (error) {
    process.stderr.write(
      "hns-obs: cannot reach " + base + " (" + (error instanceof Error ? error.name : "unknown") + ")\n",
    );
    return 2;
  }
  if (!response.ok) {
    process.stderr.write("hns-obs: /api/events returned " + response.status + "\n");
    return 2;
  }
  const body = await response.json();
  if (body?.ok !== true || !Array.isArray(body.events)) {
    process.stderr.write("hns-obs: /api/events returned an unexpected body\n");
    return 2;
  }
  const events = [...body.events].sort((left, right) => {
    const byTime = String(left.at).localeCompare(String(right.at));
    return byTime === 0 ? hopOrder(left.hop) - hopOrder(right.hop) : byTime;
  });
  process.stdout.write("request " + requestId + ": " + events.length + " event(s)\n");
  for (const event of events) {
    const detail = event.detail ?? {};
    const labels = [];
    if (detail.conversationId !== undefined) labels.push("conversation=" + detail.conversationId);
    if (detail.runId !== undefined) labels.push("run=" + detail.runId);
    if (detail.op !== undefined) labels.push("op=" + detail.op);
    process.stdout.write(
      "  " +
        text(event.hop).padEnd(7) +
        " " +
        text(event.event).padEnd(15) +
        " " +
        text(event.path).padEnd(28) +
        " status=" +
        text(event.status).padEnd(4) +
        " " +
        text(event.durationMs) +
        "ms " +
        text(event.at) +
        (labels.length === 0 ? "" : " " + labels.join(" ")) +
        "\n",
    );
  }
  const seen = new Set(events.map((event) => event.hop));
  const reached = HOPS.filter((hop) => seen.has(hop));
  process.stdout.write("reached: " + (reached.length === 0 ? "(none)" : reached.join(" -> ")) + "\n");
  if (reached.length > 0) {
    process.stdout.write("stopped after: " + text(reached.at(-1)) + "\n");
  }
  const expected = HOPS.filter((hop) => hop !== "browser");
  const missing = expected.filter((hop) => !seen.has(hop));
  if (missing.length > 0) process.stdout.write("not observed: " + missing.join(", ") + "\n");
  if (expect !== undefined && !seen.has(expect)) {
    process.stderr.write("hns-obs: stuck before " + expect + "\n");
    return 1;
  }
  return 0;
}

process.exitCode = await main();
