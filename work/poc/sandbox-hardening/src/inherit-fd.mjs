// Does a TCP connection opened by the *parent* still work from inside
// bwrap --unshare-net once the fd is inherited?
//
// If yes, --unshare-net alone is not a boundary: whatever the host process has
// open is a channel the namespace cannot take away. This opens a TCP socket to
// a loopback echo server, hands it to bwrap as fd 3, and has the sandboxed
// shell use it. It reports what the sandbox got and what the server received,
// so "the fd exists" and "the fd works" are separate facts.
import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";

const BWRAP = process.env.BWRAP ?? "bwrap";

const received = [];
const echo = createServer((socket) => {
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    received.push(chunk.toString());
    socket.write("pong:" + chunk.toString());
  });
});
await new Promise((done) => echo.listen(0, "127.0.0.1", done));
const port = echo.address().port;

const client = await new Promise((done, fail) => {
  const socket = connect({ host: "127.0.0.1", port }, () => done(socket));
  socket.on("error", fail);
});
await new Promise((done) => client.write("ping", done));

// stdio[3] keeps the caller's handle: the child gets the same TCP socket, not a
// copy made inside the sandbox (a copy is what the probe wants to rule out).
const child = spawn(
  BWRAP,
  [
    "--unshare-net",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--unshare-pid",
    "--",
    "/run/current-system/sw/bin/sh",
    "-c",
    // Write one frame, read one frame; both sides use the same 13-byte size.
    "printf 'fromchild' >&3; head -c 13 <&3; echo [end]",
  ],
  { stdio: ["ignore", "pipe", "pipe", client] },
);
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));
await new Promise((done) => child.on("close", done));

// The child's exit closes its copy of the fd; the parent's own socket can then
// see the peer go away, and that is not a finding.
client.on("error", () => {});
client.destroy();
echo.close();

process.stdout.write(
  JSON.stringify(
    {
      sandboxStdout: stdout.trim(),
      sandboxStderr: stderr.trim(),
      serverReceived: received,
      inheritedTcpWorks: received.includes("fromchild"),
    },
    null,
    2,
  ) + "\n",
);
