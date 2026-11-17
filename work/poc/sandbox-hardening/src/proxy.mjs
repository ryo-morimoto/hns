// A host-side egress proxy for the S2 probe.
//
// The sandbox (--unshare-net) has no route out, only one Unix socket on the host.
// This listener speaks what the tools speak:
//
//   CONNECT  "CONNECT host:port HTTP/1.1" -> "HTTP/1.1 200 Connection established",
//            then raw bytes both ways. That is what git, curl -x, and npm use for https.
//   GET/...  the absolute-URL form is rewritten to origin form and forwarded, so
//            "curl -x <uds> http://host/" works without TLS.
//
// Every request is logged as one JSON line (requested host/port and the decision).
// The log is the C4 evidence: a host the probe never asked for shows up as an
// extra "allow" entry.
//
// Usage: node proxy.mjs uds SOCKET_PATH LOG_PATH
//        node proxy.mjs tcp ADDR LOG_PATH      (ADDR "127.0.0.1:0" picks a port)
//
// The TCP form is the control for tools that only accept a proxy URL: it proves
// the proxy and the host network work, so a UDS failure is about the socket and
// not about the proxy.
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import { connect, createServer } from "node:net";

const [mode, targetPath, logPath] = process.argv.slice(2);
if ((mode !== "uds" && mode !== "tcp") || targetPath === undefined || logPath === undefined) {
  process.stderr.write("usage: node proxy.mjs uds|tcp ADDR LOG_PATH\n");
  process.exit(2);
}

// The path lives in a temp dir the probe owns; a killed run can leave the socket
// behind and listen() would then fail with EADDRINUSE.
if (mode === "uds" && existsSync(targetPath)) unlinkSync(targetPath);

const log = (entry) => {
  appendFileSync(logPath, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
};

/** Split the first request head off the buffered bytes; null until a full line is in. */
function takeHead(buffered) {
  const lineEnd = buffered.indexOf("\r\n");
  const headEnd = buffered.indexOf("\r\n\r\n");
  if (lineEnd < 0) return null;
  if (headEnd < 0 && buffered.length > 16 * 1024) return null;
  const head = buffered.subarray(0, headEnd < 0 ? lineEnd : headEnd).toString("latin1");
  const end = headEnd < 0 ? lineEnd + 2 : headEnd + 4;
  return { head, rest: buffered.subarray(end), complete: headEnd >= 0 };
}

/** The host/port a request line names, or undefined when it cannot be read. */
function destination(method, target, head) {
  if (method === "CONNECT") {
    const index = target.lastIndexOf(":");
    if (index <= 0) return { host: target, port: 443 };
    return { host: target.slice(0, index), port: Number(target.slice(index + 1)) };
  }
  if (target.startsWith("http://") || target.startsWith("https://")) {
    const url = new URL(target);
    return { host: url.hostname, port: Number(url.port === "" ? (url.protocol === "https:" ? 443 : 80) : url.port) };
  }
  // Origin form: the Host header carries the destination.
  const host = head.match(/^host: *(\S+)/im)?.[1];
  if (host === undefined) return undefined;
  const index = host.lastIndexOf(":");
  if (index <= 0) return { host, port: 80 };
  return { host: host.slice(0, index), port: Number(host.slice(index + 1)) };
}

const server = createServer((client) => {
  let buffered = Buffer.alloc(0);
  let handled = false;

  const onData = (chunk) => {
    if (handled) return;
    buffered = Buffer.concat([buffered, chunk]);
    const taken = takeHead(buffered);
    if (taken === null || !taken.complete) {
      if (buffered.length > 16 * 1024) client.destroy();
      return;
    }
    const requestLine = taken.head.split("\r\n")[0] ?? "";
    const [method, target] = requestLine.split(" ");
    if (method === undefined || target === undefined) {
      log({ decision: "reject", reason: "malformed", line: requestLine.slice(0, 80) });
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const destinationOf = destination(method, target, taken.head);
    if (destinationOf === undefined || !Number.isInteger(destinationOf.port)) {
      log({ decision: "reject", reason: "no-host", line: requestLine.slice(0, 80) });
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    handled = true;
    client.removeListener("data", onData);
    const { host, port } = destinationOf;
    const upstream = connect({ host, port }, () => {
      log({ decision: "allow", host, port, method });
      if (method === "CONNECT") {
        client.write("HTTP/1.1 200 Connection established\r\n\r\n");
      } else {
        // The absolute-URL form becomes origin form; headers pass through as they are.
        const url = new URL(target);
        // head is "METHOD TARGET HTTP/1.1\r\nheaders..." with the blank line
        // consumed by the split; keep the version and headers, swap the absolute
        // target for its path, and restore the terminating empty line.
        const afterTarget = taken.head.slice(taken.head.indexOf(" ") + target.length + 1);
        upstream.write(method + " " + url.pathname + url.search + afterTarget + "\r\n\r\n");
      }
      const rest = taken.rest;
      if (rest.length > 0) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", (error) => {
      log({ decision: "reject", reason: error.code ?? "error", host, port });
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    client.on("error", () => upstream.destroy());
  };
  client.on("data", onData);
});

const [host, port] = mode === "uds" ? [] : targetPath.split(":");
server.listen(mode === "uds" ? targetPath : { host: host ?? "127.0.0.1", port: Number(port ?? 0) }, () => {
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : "?";
  // The probe reads the port from this line; "listening" alone is for the UDS.
  process.stdout.write("listening " + String(bound) + "\n");
});