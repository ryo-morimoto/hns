// Walking skeleton: client → Worker (HTTP) → ExecutionEnv (pi-env daemon) → files.
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutionEnv, Connection, localDaemon } from "@earendil-works/pi-env";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Denied, Workspace } from "../workspace-core/workspace.mjs";

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const bodyOf = (req) => new Promise((resolve, reject) => {
  let text = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => (text += chunk));
  req.on("end", () => { try { resolve(text ? JSON.parse(text) : {}); } catch (e) { reject(e); } });
  req.on("error", reject);
});

export async function startServer({ env, root, journalPath }) {
  const ws = await new Workspace({ env, root, journalPath, context: ctx }).open();
  await ws.recover();
  await ws.startWatching();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/read") {
        return json(res, 200, await ws.read(url.searchParams.get("path")));
      }
      if (req.method === "POST" && url.pathname === "/write") {
        const outcome = await ws.write(await bodyOf(req));
        return json(res, outcome.status === "applied" ? 200 : outcome.status === "conflict" ? 409 : 202, outcome);
      }
      if (req.method === "GET" && url.pathname === "/events") {
        const cursor = url.searchParams.get("cursor") ?? "0";
        const limit = Number(url.searchParams.get("limit") ?? "0");
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        let sent = 0;
        for await (const event of ws.watch(cursor)) {
          res.write(JSON.stringify(event) + "\n");
          if (limit && ++sent >= limit) break;
        }
        return res.end();
      }
      // Test hooks: a change that bypasses Workspace, and a simulated coverage overflow.
      if (req.method === "POST" && url.pathname === "/debug/touch") {
        const body = await bodyOf(req);
        await env.writeFile(join(root, body.path), body.content, ctx);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/debug/overflow") {
        return json(res, 200, await ws.overflow());
      }
      if (req.method === "GET" && url.pathname === "/audit") {
        return json(res, 200, ws.auditLog);
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof Denied) return json(res, 403, { error: error.message });
      return json(res, 500, { error: String(error?.message ?? error) });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: "http://127.0.0.1:" + port,
    ws,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await ws.close();
    },
  };
}

if (import.meta.url === "file://" + process.argv[1]) {
  const base = await mkdtemp(join(tmpdir(), "hns-skeleton-"));
  const root = join(base, "root");
  const connection = new Connection({ command: [localDaemon()] });
  const env = new LocalExecutionEnv({ cwd: base, connection });
  await env.createDir(root, undefined, ctx);
  const app = await startServer({ env, root, journalPath: join(base, "journal.json") });
  console.log("root:", root);
  console.log("url: ", app.url);
  console.log(`curl -s -X POST ${app.url}/write -d '{"path":"a.txt","content":"hello","expectedVersion":"absent","operationId":"w1"}'`);
  console.log(`curl -s '${app.url}/events?cursor=0&limit=1'`);
  process.on("SIGINT", async () => { await app.close(); await connection.close(); process.exit(0); });
}