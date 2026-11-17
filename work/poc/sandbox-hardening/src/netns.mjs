// S2: can --unshare-net plus a UDS proxy carry git, npm, curl, and ssh?
//
// The proxy (src/proxy.mjs) runs on the host, where the network is. The
// sandboxed process has no route out and one Unix socket; the tools are pointed
// at the socket the way they are pointed at any proxy:
//
//   curl   -x http://localhost:<port> needs TCP, so curl gets the socket through
//          the shim only by giving up its own proxy code. See the research note:
//          curl has no Unix-socket proxy transport, so the probe runs the tunnel
//          directly and reports that separately from "curl -x".
//   git    http.proxy = "http://localhost:<port>" cannot reach a UDS either;
//          git's http.proxy is a URL, not a command. The shim (ProxyCommand) is
//          what works here, so git is measured through it.
//   npm    proxy/https-proxy = URL, same limitation; through the shim.
//   ssh    ProxyCommand = the shim: this is the supported UDS path.
//
// So the table distinguishes "the tool can use an HTTP proxy URL" from "the tool
// can reach a Unix socket". Both are recorded; the conclusion is in the report.
//
// The bypass cases are the point of S2: --unshare-net only removes routes. A raw
// socket, netlink, and an fd inherited from the parent are each tried.
//
// Usage: node src/netns.mjs [--out PATH]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BWRAP = process.env.BWRAP ?? "bwrap";
const SHELL = "/run/current-system/sw/bin/sh";
const NODE = process.execPath;
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;

// A Unix socket path is limited to 108 bytes, so the workdir cannot live under
// the repository path: it goes in /tmp. "logDir" is the repository-side copy
// because /tmp here is a per-command tmpfs; the probe copies the log there.
const workdir = realpathSync(await mkdtemp(join(tmpdir(), "hns-s2-")));
const socketPath = join(workdir, "p.sock");
const logPath = join(workdir, "proxy.log");
/** Where the proxy log is copied before the temp dir is removed. */
const logDir = join(import.meta.dirname, "..", "..", "..", "..", ".cache", "measure");
await mkdir(logDir, { recursive: true });
const shim = join(import.meta.dirname, "proxy-shim.sh");
const results = [];
const record = (id, name, ok, detail) => {
  results.push({ id, name, ok, detail: detail ?? null });
  process.stderr.write((ok ? "PASS " : "FAIL ") + id + " " + name + "\n");
};

// --- the proxy (host side) -------------------------------------------------
const proxy = spawn(NODE, [join(import.meta.dirname, "proxy.mjs"), "uds", socketPath, logPath], {
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((done, fail) => {
  proxy.stdout.once("data", done);
  proxy.on("error", fail);
});

// The control: the same proxy on a TCP port the sandbox cannot reach either
// (--unshare-net has no route), so the control runs *outside* bwrap. It is what
// tells "the tunnel carries https" apart from "these tools cannot use a UDS".
const tcpLog = join(workdir, "control.log");
const tcp = spawn(NODE, [join(import.meta.dirname, "proxy.mjs"), "tcp", "127.0.0.1:0", tcpLog], {
  stdio: ["ignore", "pipe", "inherit"],
});
const tcpPort = await new Promise((done, fail) => {
  let buffered = "";
  tcp.stdout.on("data", (chunk) => {
    buffered += chunk;
    const match = /listening (\d+)/.exec(buffered);
    if (match?.[1] !== undefined) done(Number(match[1]));
  });
  tcp.on("error", fail);
});
// Poll the control until it answers, so a "connect refused" in a later case
// means the tool, not a proxy that is still binding.
await new Promise((done, fail) => {
  const started = Date.now();
  const attempt = () => {
    const socket = connect({ host: "127.0.0.1", port: tcpPort }, () => {
      socket.destroy();
      done();
    });
    socket.on("error", () => {
      if (Date.now() - started > 10_000) fail(new Error("control proxy never accepted on " + String(tcpPort)));
      else setTimeout(attempt, 100);
    });
  };
  attempt();
});

/** bwrap argv shared by every case: the product mount shape plus --unshare-net. */
const sandboxArgs = (extra) => [
  "--die-with-parent",
  "--unshare-net",
  "--ro-bind", "/", "/",
  "--bind", workdir, workdir,
  "--dev", "/dev",
  "--proc", "/proc",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  ...extra,
  "--",
];

/** Environment every sandboxed command gets; HOME/TMPDIR are the writable workdir. */
const envArgs = (extra) => [
  "--clearenv",
  "--setenv", "PATH", "/run/current-system/sw/bin:/usr/bin:/bin",
  "--setenv", "HOME", workdir,
  "--setenv", "TMPDIR", workdir,
  ...extra,
  "--chdir", workdir,
];

const run = (argv, options = {}) =>
  spawnSync(BWRAP, argv, {
    encoding: "utf8",
    timeout: options.timeout ?? 90_000,
    input: options.input,
    env: { ...process.env, ...options.env },
  });

// A ProxyCommand that git and ssh substitute %h/%p into; the socket is baked in.
const proxyCommand = (hostPlaceholder, portPlaceholder) =>
  SHELL + " -c 'HNS_PROXY_SOCKET=" + socketPath + " HNS_NODE=" + NODE + " exec " + shim + " " + hostPlaceholder + " " + portPlaceholder + "'";

const cases = [
  {
    // ssh is the one tool here whose config names a *command*: ProxyCommand is
    // exactly the shape a UDS tunnel fits. It is the S2 happy path.
    id: "C3-ssh",
    name: "ssh to github.com through ProxyCommand over the shim",
    args: () => ["--setenv", "HNS_PROXY_SOCKET", socketPath, "--setenv", "HNS_NODE", NODE],
    command: [
      "ssh",
      // -F /dev/null: the system ssh_config.d files are refused for permissions
      // inside the sandbox, which is a property of this host, not of the tunnel.
      "-F", "/dev/null",
      "-T",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ProxyCommand=" + SHELL + " -c 'exec " + shim + " %h %p'",
      "-o", "ConnectTimeout=20",
      "-o", "BatchMode=yes",
      "git@github.com",
    ],
    // GitHub answers the ssh handshake, then refuses the key; the tunnel working
    // is what matters. ssh also reports the auth refusal as 255, so the test is
    // the message: reaching the server prints "Permission denied (publickey)",
    // while an unreachable host prints "Connection refused/timed out".
    acceptExit: (status) => status !== 255,
    acceptStderr: (stderr) => stderr.includes("Permission denied"),
  },
  {
    id: "C3-ssh-noproxy",
    name: "ssh without the tunnel: no route",
    args: () => [],
    command: ["ssh", "-F", "/dev/null", "-T", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", "git@github.com"],
    expect: "fail",
  },
  {
    // git's http.proxy is a URL, not a command. A Unix socket has no URL, and
    // git refuses the path form ("only SOCKS proxies support paths"). This is a
    // real limit, recorded rather than worked around.
    id: "C3-git-url",
    name: "git http.proxy as a UDS path: refused, git wants a URL",
    args: () => ["--setenv", "GIT_TERMINAL_PROMPT", "0"],
    command: [
      "git", "-c", "http.proxy=" + socketPath, "ls-remote", "--heads",
      "https://github.com/octocat/Hello-World.git", "master",
    ],
    expect: "fail",
  },
  {
    id: "C3-git-tcp",
    name: "git through a TCP proxy: control (the tunnel itself carries https)",
    args: () => ["--setenv", "GIT_TERMINAL_PROMPT", "0"],
    // The same proxy reached over TCP, which shows the proxy and the host side
    // work; the UDS-only variant above is where git stops.
    command: ["git", "-c", "http.proxy=http://127.0.0.1:" + String(tcpPort), "ls-remote", "--heads", "https://github.com/octocat/Hello-World.git", "master"],
  },
  {
    id: "C3-npm-url",
    name: "npm proxy config as a UDS path: refused, npm validates a URL",
    args: () => ["--setenv", "npm_config_proxy", socketPath, "--setenv", "npm_config_https_proxy", socketPath],
    command: ["npm", "view", "left-pad", "version"],
    expect: "fail",
  },
  {
    id: "C3-npm-tcp",
    name: "npm through a TCP proxy: control",
    args: () => [
      "--setenv", "npm_config_proxy", "http://127.0.0.1:" + String(tcpPort),
      "--setenv", "npm_config_https_proxy", "http://127.0.0.1:" + String(tcpPort),
      "--setenv", "npm_config_update_notifier", "false",
    ],
    command: ["npm", "view", "left-pad", "version"],
    // npm writes its cache and logs under HOME; the control must own a writable one.
    controlEnv: { npm_config_cache: join(workdir, "npm-cache"), npm_config_update_notifier: "false" },
  },
  {
    // curl -x wants a TCP proxy URL. Inside --unshare-net even the host's own
    // control port is unreachable, so this records the limit: a tool whose proxy
    // setting is host:port cannot be pointed at a Unix socket at all.
    id: "C3-curl-x",
    name: "curl -x to a TCP proxy inside the netns: no route (UDS is the only way)",
    args: () => [],
    command: ["curl", "-sS", "-m", "10", "-x", "http://127.0.0.1:" + String(tcpPort), "-o", "/dev/null", "https://example.com"],
    expect: "fail",
  },
  {
    id: "C3-curl-x-tcp",
    name: "curl -x through a TCP proxy outside the sandbox: control",
    args: () => [],
    command: ["curl", "-sS", "-m", "20", "-x", "http://127.0.0.1:" + String(tcpPort), "-o", "/dev/null", "-w", "%{http_code}", "https://example.com"],
    controlEnv: {},
  },
  {
    // The same request over the UDS tunnel, by hand: this is what a tool would do
    // if it could be pointed at a Unix socket.
    id: "C3-curl-uds",
    name: "curl over http through the UDS tunnel (shim, not curl -x)",
    args: () => ["--setenv", "HNS_PROXY_SOCKET", socketPath, "--setenv", "HNS_NODE", NODE],
    command: [
      SHELL, "-c",
      'printf "GET http://example.com/ HTTP/1.1\\r\\nHost: example.com\\r\\nConnection: close\\r\\n\\r\\n" | ' +
        "HNS_PROXY_SOCKET=\"$HNS_PROXY_SOCKET\" HNS_NODE=\"$HNS_NODE\" exec " + shim + " example.com 80",
    ],
  },
];

for (const testCase of cases) {
  // A "-tcp" control runs on the host: the sandbox has no route to that port,
  // which is exactly why the tool cannot use a URL-shaped proxy from inside.
  const outcome =
    testCase.id.endsWith("-tcp")
      ? spawnSync(testCase.command[0], testCase.command.slice(1), {
          encoding: "utf8",
          timeout: 120_000,
          env: { ...process.env, ...testCase.controlEnv },
        })
      : run([...sandboxArgs(envArgs(testCase.args())), ...testCase.command]);
  const ok =
    testCase.expect === "fail"
      ? outcome.status !== 0
      : testCase.acceptStderr !== undefined
        ? testCase.acceptStderr(outcome.stderr ?? "")
        : testCase.acceptExit !== undefined
          ? testCase.acceptExit(outcome.status)
          : outcome.status === 0;
  record(testCase.id, testCase.name, ok, {
    status: outcome.status,
    // The control cases show the exact argv so a failure names its port.
    argv: testCase.id.endsWith("-tcp") || testCase.id === "C3-curl-x"
      ? testCase.command.filter((item) => item.startsWith("http://"))
      : undefined,
    stdout: (outcome.stdout ?? "").trim().slice(0, 200),
    stderr: (outcome.stderr ?? "").trim().slice(-300),
  });
}

// Without the proxy, the same git command must fail: the namespace is closed.
const noProxy = run([
  ...sandboxArgs(envArgs(["--setenv", "GIT_TERMINAL_PROMPT", "0"])),
  "git", "ls-remote", "--heads", "https://github.com/octocat/Hello-World.git", "master",
]);
record("C3-without", "git without the proxy fails: the namespace has no route", noProxy.status !== 0, {
  status: noProxy.status,
  stderr: (noProxy.stderr ?? "").trim().slice(-200),
});

// Bypass 1: no route and no resolver inside the netns.
const rawCheck = run([
  ...sandboxArgs(envArgs([])),
  SHELL, "-c",
  [
    "ip link show lo >/dev/null 2>&1 && echo lo=present",
    "ip route show; echo routes_done",
    "curl -sS -m 3 http://1.1.1.1 >/dev/null 2>&1; echo raw_ip=$?",
    // \/etc\/resolv.conf alone decides nothing: a resolver that is never reached
    // because there is no route is the fact being recorded.
    "node -e 'require(\"node:dns\").lookup(\"example.com\", (e) => { console.log(\"dns=\" + (e ? e.code : \"ok\")); })' 2>&1",
  ].join("; "),
]);
record(
  "C3-bypass-raw",
  "inside --unshare-net: no route, no DNS (lo only)",
  /raw_ip=[^0]/.test(rawCheck.stdout ?? "") && /dns=[^0]/.test(rawCheck.stdout ?? ""),
  { stdout: rawCheck.stdout, stderr: rawCheck.stderr },
);

// Bypass 2: netlink cannot reconfigure the namespace to get a route.
const netlink = run([
  ...sandboxArgs(envArgs([])),
  SHELL, "-c",
  "ip addr add 100.64.0.2/32 dev lo 2>&1; echo add=$?; ip route add default via 100.64.0.1 2>&1; echo route=$?",
]);
record(
  "C3-bypass-netlink",
  "netlink cannot add a route to the host network",
  /add=[^0]|route=[^0]/.test(netlink.stdout ?? ""),
  { stdout: netlink.stdout, stderr: netlink.stderr },
);

// Bypass 3: a TCP fd the parent opened is inherited and still crosses the namespace.
const echo = createServer((socket) => {
  socket.on("error", () => {});
  socket.on("data", (chunk) => socket.write("pong:" + chunk.toString()));
});
await new Promise((done) => echo.listen(0, "127.0.0.1", done));
const inherited = await new Promise((done, fail) => {
  const socket = connect({ host: "127.0.0.1", port: echo.address().port }, () => done(socket));
  socket.on("error", fail);
});
await new Promise((done) => inherited.write("from-parent", done));
const inheritedResult = await new Promise((done) => {
  const child = spawn(BWRAP, [...sandboxArgs(envArgs([])), SHELL, "-c", "printf from-child >&3; head -c 24 <&3"], {
    stdio: ["ignore", "pipe", "pipe", inherited],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.on("close", (status) => done({ status, stdout, stderr }));
});
inherited.on("error", () => {});
inherited.destroy();
echo.close();
record("C3-bypass-fd", "an inherited TCP fd crosses --unshare-net", inheritedResult.stdout.includes("pong:"), inheritedResult);

// C4: the proxy log holds only the hosts the probe asked for.
const log = existsSync(logPath)
  ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : [];
const allowed = new Set(["github.com", "example.com", "registry.npmjs.org", "127.0.0.1"]);
const unexpected = log.filter((entry) => entry.decision === "allow" && !allowed.has(entry.host));
record("C4-log", "every allowed host is one the probe asked for", unexpected.length === 0 && log.length > 0, {
  entries: log.length,
  hosts: [...new Set(log.map((entry) => entry.host ?? entry.reason))],
  unexpected,
});

// Copy the log out of /tmp before the temp dir goes; it is C4's only evidence.
if (existsSync(logPath) && outPath !== undefined) {
  await copyFile(logPath, join(logDir, "netns-proxy.log"));
}
proxy.kill();
tcp.kill();
await sleep(100);
await rm(workdir, { recursive: true, force: true });

const report = { measuredAt: new Date().toISOString(), bwrap: BWRAP, results };
const text = JSON.stringify(report, null, 2) + "\n";
if (outPath !== undefined) writeFileSync(outPath, text);
process.stdout.write(text);