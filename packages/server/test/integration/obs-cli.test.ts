import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
  isoTimestamp,
  type EventName,
  type ObsDetail,
  type ObsHop,
  type ObsLogEntry,
} from "@hns/core";
import { expect, test } from "vitest";
import * as v from "valibot";

const SCRIPT = fileURLToPath(new URL("../../../../tools/obs/trace.mjs", import.meta.url));

interface Served {
  readonly url: string;
  readonly requests: string[];
  readonly requestIds: (string | undefined)[];
  close(): Promise<void>;
}

const AddressSchema = v.object({ port: v.number() });

/** The bound port of a test server, or a failure that fails the test. */
function portOf(server: ReturnType<typeof createServer>): number {
  const parsed = v.safeParse(AddressSchema, server.address());
  if (!parsed.success) throw new Error("the server did not obtain a port");
  return parsed.output.port;
}

/** Serve one /api/events body on loopback and record the query the command sent. */
async function serve(events: readonly ObsLogEntry[]): Promise<Served> {
  const requests: string[] = [];
  const requestIds: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const id = request.headers["x-request-id"];
    requestIds.push(Array.isArray(id) ? id.join(",") : id);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, events }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: "http://127.0.0.1:" + String(portOf(server)),
    requests,
    requestIds,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the command and collect its output; no shell, so arguments are exact. */
function trace(args: readonly string[], env: Record<string, string>): Promise<Run> {
  return new Promise<Run>((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/** One event the fake API returns, with a time derived from the hop. */
function event(
  hop: ObsHop,
  name: EventName,
  path: string,
  status: number,
  detail?: ObsDetail,
): ObsLogEntry {
  const entry: ObsLogEntry = {
    v: 1,
    at: isoTimestamp("2026-11-17T12:00:0" + String(hop.length) + ".000Z"),
    level: "info",
    event: name,
    hop,
    requestId: "req-1",
    path,
    status,
    durationMs: 1,
  };
  return detail === undefined ? entry : { ...entry, detail };
}

// Catches: the command printing a list without naming where the request stopped.
test("the trace command names the hop where the request stopped", async () => {
  const served = await serve([
    event("worker", "http", "/graphql", 200),
    event("do", "do.rpc", "/rpc/events", 200),
    event("agent", "agent.response", "/", 200, { conversationId: "2" }),
  ]);
  try {
    const run = await trace(["req-1", "--expect", "fs"], {
      HNS_URL: served.url,
      HNS_SESSION_COOKIE: "hns_session=test",
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("stopped after: agent");
    expect(run.stdout).toContain("not observed: fs");
    expect(run.stdout).toContain("conversation=2");
    expect(served.requests[0]).toContain("requestId=req-1");
    expect(served.requestIds[0]).toBeUndefined();
  } finally {
    await served.close();
  }
});

test("the trace command passes once every expected hop is observed", async () => {
  const served = await serve([
    event("worker", "http", "/graphql", 200),
    event("do", "do.rpc", "/rpc/events", 200),
    event("agent", "agent.response", "/", 200),
    event("fs", "fs.op", "/a.txt", 200, { op: "read" }),
  ]);
  try {
    const run = await trace(["req-1", "--expect", "fs"], {
      HNS_URL: served.url,
      HNS_SESSION_COOKIE: "hns_session=test",
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("reached: worker -> do -> agent -> fs");
    expect(run.stdout).toContain("op=read");
  } finally {
    await served.close();
  }
});

test("the command exits 2 when the endpoint refuses", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(401);
    response.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const run = await trace(["req-1"], {
      HNS_URL: "http://127.0.0.1:" + String(portOf(server)),
      HNS_SESSION_COOKIE: "hns_session=test",
    });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("401");
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});
