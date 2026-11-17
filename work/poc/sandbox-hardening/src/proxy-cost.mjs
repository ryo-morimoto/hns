import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, connect } from "node:net";
import { join } from "node:path";

const dir = mkdtempSync(join(import.meta.dirname, "..", "..", "..", "..", ".cache", "cost-"));
const echo = createServer((socket) => {
  socket.on("error", () => {});
  socket.on("data", (chunk) => socket.write(chunk));
});
await new Promise((done) => echo.listen(0, "127.0.0.1", done));
const port = echo.address().port;
const proxy = spawn(process.execPath, [join(import.meta.dirname, "proxy.mjs"), "uds", join(dir, "p.sock"), join(dir, "log")], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((done) => proxy.stdout.once("data", done));

const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
const time = (start) => Number(process.hrtime.bigint() - start) / 1e6;
const direct = [];
const viaProxy = [];
for (let round = 0; round < 200; round += 1) {
  const startDirect = process.hrtime.bigint();
  await new Promise((done, fail) => {
    const socket = connect(port, "127.0.0.1", () => socket.write("x"));
    socket.on("data", () => { socket.destroy(); done(); });
    socket.on("error", fail);
  });
  direct.push(time(startDirect));

  const startProxy = process.hrtime.bigint();
  await new Promise((done, fail) => {
    const socket = connect(join(dir, "p.sock"), () => {
      socket.write("CONNECT 127.0.0.1:" + String(port) + " HTTP/1.1" + CRLF + "Host: x" + CRLF + CRLF);
    });
    let buffered = "";
    let sent = false;
    socket.on("data", (chunk) => {
      buffered += chunk;
      if (!sent && buffered.includes("200 Connection established")) {
        socket.write("x");
        sent = true;
      } else if (sent && buffered.includes("x")) {
        socket.destroy();
        done();
      }
    });
    socket.on("error", fail);
  });
  viaProxy.push(time(startProxy));
}
const percentile = (values, fraction) => values.sort((left, right) => left - right)[Math.ceil(fraction * values.length) - 1].toFixed(3);
console.log("direct  p50=" + percentile(direct, 0.5) + " p95=" + percentile(direct, 0.95));
console.log("viaUDS  p50=" + percentile(viaProxy, 0.5) + " p95=" + percentile(viaProxy, 0.95));
proxy.kill();
echo.close();
