// A host client that speaks the proxy's HTTP CONNECT over the Unix socket.
//
// The tools that accept only a proxy *URL* (git, npm) cannot reach a UDS, but
// ssh's ProxyCommand can run any command, and this is that command: it opens the
// socket, sends "CONNECT host:port", and then becomes a raw byte pipe. git and
// ssh both put the destination in the arguments, never in the framing.
//
// Usage: node client.mjs tcp-pipe <socket> <host> <port>
//   stdin  -> tunnel -> proxy -> host:port
//   host   -> proxy -> tunnel -> stdout
// Exit: 0 when the tunnel was established and the far side closed, 3 no socket,
// 4 the proxy refused, 5 the socket closed before the answer.
import { connect } from "node:net";
import process from "node:process";

const [mode, socketPath, host, portText] = process.argv.slice(2);
if (mode !== "tcp-pipe" || socketPath === undefined || host === undefined || portText === undefined) {
  process.stderr.write("usage: node client.mjs tcp-pipe <socket> <host> <port>\n");
  process.exit(2);
}
const port = Number(portText);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write("bad port " + portText + "\n");
  process.exit(2);
}

const socket = connect(socketPath);
let answered = false;
let buffered = Buffer.alloc(0);
let stdinEnded = false;

socket.on("error", (error) => {
  if (!answered) {
    process.stderr.write("proxy connect failed: " + String(error.code) + "\n");
    process.exit(3);
  }
  process.exit(0);
});
socket.on("data", (chunk) => {
  if (answered) {
    process.stdout.write(chunk);
    return;
  }
  buffered = Buffer.concat([buffered, chunk]);
  const newline = buffered.indexOf(0x0a);
  if (newline < 0) return;
  const answer = buffered.subarray(0, newline).toString().trim();
  const rest = buffered.subarray(newline + 1);
  answered = true;
  if (!answer.startsWith("HTTP/1.1 200")) {
    process.stderr.write("proxy refused: " + answer + "\n");
    process.exit(4);
  }
  if (rest.length > 0) process.stdout.write(rest);
  process.stdin.pipe(socket);
  process.stdin.on("end", () => {
    stdinEnded = true;
    socket.end();
  });
});
socket.on("connect", () => {
  // HTTP CONNECT names the destination as host:port in the request line.
  socket.write("CONNECT " + host + ":" + String(port) + " HTTP/1.1\r\nHost: " + host + ":" + String(port) + "\r\n\r\n");
});
socket.on("close", () => {
  if (stdinEnded) return;
  process.exit(answered ? 0 : 5);
});
