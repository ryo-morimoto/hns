import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";

/**
 * A local **https** git remote, standing in for Artifacts in the mirror's real-path tests.
 *
 * @remarks
 * The mirror only talks to an `https://` remote (0246's NB2), so a bare path is not a remote the
 * tests may use: they would exercise a transport the product refuses. This serves a bare
 * repository over TLS from git's own `git-http-backend` (smart HTTP: `info/refs` and
 * `git-receive-pack`), with a self-signed certificate for `127.0.0.1`. The certificate is trusted
 * by the git processes the test runs through `GIT_SSL_CAINFO`, which the mirror's environment
 * inherits: the push and the read-back go over real TLS through the real transport git uses for
 * Artifacts.
 *
 * The backend is one CGI process per request; its stdout starts with an HTTP header block that is
 * translated into the response head, and the rest is streamed as the body.
 */

/** What `server.address()` answers for the TCP listener this helper opens. */
const AddressSchema: v.GenericSchema<unknown, AddressInfo> = v.object({
  address: v.string(),
  family: v.string(),
  port: v.number(),
});

/** A running https git remote. */
export interface HttpsGitRemote {
  /** `https://127.0.0.1:<port>/<repo>.git`. */
  readonly remote: string;
  /** The certificate the server presents; git trusts it through `GIT_SSL_CAINFO`. */
  readonly certificate: string;
  /** The bare repository the server exports. */
  readonly directory: string;
  /** Stop the server and remove its temporary directory. */
  close(): Promise<void>;
}

/** The environment every fixture's git runs in, with the repository variables removed. */
const fixtureEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR",
  ]) {
    delete env[name];
  }
  return env;
};

/** Translate the backend's CGI answer into the response. */
function serveBackend(
  backend: string,
  projectRoot: string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const url = new URL(request.url ?? "/", "https://127.0.0.1");
  const child = spawn(backend, [], {
    env: {
      ...fixtureEnv(),
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname,
      REQUEST_METHOD: request.method ?? "GET",
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: String(request.headers["content-type"] ?? ""),
      GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // The CGI protocol reads its request body from stdin until EOF, and the client waits for the
  // answer before it ends a POST: the body is collected first and written whole, so stdin is
  // ended exactly when the request ended.
  const body: Uint8Array[] = [];
  request.on("data", (chunk: Uint8Array) => body.push(chunk));
  request.on("end", () => child.stdin.end(Buffer.concat(body)));
  let head = Buffer.alloc(0);
  let sent = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (sent) {
      // The body is streamed; a `Connection: keep-alive` would let the client wait for a length.
      response.write(chunk);
      return;
    }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) return;
    // A CGI answer is a header block, not an HTTP response: its status is the `Status:` header
    // (`git-http-backend` sends that, not a status line), and 200 when it sends none. The body
    // is chunked by Node, so the answer always says how it ends.
    const lines = head.subarray(0, end).toString("utf8").split("\r\n");
    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of lines) {
      const at = line.indexOf(":");
      if (at <= 0) continue;
      const name = line.slice(0, at);
      const value = line.slice(at + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0] ?? 200);
      else if (name.toLowerCase() === "content-length") continue;
      else if (name.toLowerCase() === "connection") continue;
      else headers[name] = value;
    }
    response.writeHead(Number.isFinite(status) ? status : 500, headers);
    response.write(head.subarray(end + 4));
    sent = true;
  });
  child.on("error", () => response.writeHead(500).end());
  child.on("close", () => {
    if (!sent) response.writeHead(500).end();
    else response.end();
  });
}

/**
 * Serve one bare repository over https.
 *
 * @param options - The repository to export and optional git settings (`http.receivepack`).
 * @returns The running remote; `close` stops it and removes the certificate.
 */
export async function httpsGitRemote(options: {
  readonly repository: string;
  readonly name?: string;
}): Promise<HttpsGitRemote> {
  const name = options.name ?? "remote.git";
  const parent = await mkdtemp(join(tmpdir(), "hns-https-git-"));
  const directory = join(parent, "git", name);
  // The backend's project root is the parent of the repository, so the URL's path names it.
  execFileSync("git", ["clone", "-q", "--bare", options.repository, directory], {
    env: fixtureEnv(),
  });
  execFileSync("git", ["-C", directory, "config", "http.receivepack", "true"], {
    env: fixtureEnv(),
  });
  const key = join(parent, "key.pem");
  const cert = join(parent, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const backend = join(
    execFileSync("git", ["--exec-path"], { encoding: "utf8", env: fixtureEnv() }).trim(),
    "git-http-backend",
  );
  const projectRoot = join(parent, "git");
  const server: Server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (request, response) => serveBackend(backend, projectRoot, request, response),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = v.safeParse(AddressSchema, server.address());
  if (!address.success) throw new Error("the https remote has no TCP address");
  return {
    remote: "https://127.0.0.1:" + String(address.output.port) + "/" + name,
    certificate: cert,
    directory,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(parent, { recursive: true, force: true });
    },
  };
}
