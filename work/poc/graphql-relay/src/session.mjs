import { createServer } from "node:http";

// One Session actor per workspace, standing in for a Durable Object:
// the live state lives here, and every read of it is an RPC.
export function startSession({ wsId, states }) {
  let rpcCount = 0;
  const state = new Map(states);

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const send = (value) => {
        const text = JSON.stringify(value);
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        res.end(text);
      };
      const url = req.url ?? "/";
      if (url === "/rpc/status-one") {
        rpcCount += 1;
        const { id } = JSON.parse(body);
        send({ state: state.get(id) ?? null });
        return;
      }
      if (url === "/rpc/status") {
        rpcCount += 1;
        const { ids } = JSON.parse(body);
        const out = {};
        for (const id of ids) out[id] = state.get(id) ?? null;
        send({ states: out });
        return;
      }
      if (url === "/rpc/set") {
        const { id, next } = JSON.parse(body);
        state.set(id, next);
        send({ ok: true, rpc: rpcCount });
        return;
      }
      if (url === "/rpc/all") {
        // The projection job reads every workspace on a timer. It is not on the
        // request path, so it is not counted as a billed read (D048 avoids this).
        send({ states: Object.fromEntries(state) });
        return;
      }
      if (url === "/rpc/count") {
        send({ rpc: rpcCount });
        return;
      }
      res.writeHead(404).end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        wsId,
        url: "http://127.0.0.1:" + port,
        get rpcCount() {
          return rpcCount;
        },
        setLive(id, next) {
          state.set(id, next);
        },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
