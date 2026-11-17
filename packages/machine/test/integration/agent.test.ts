import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath, symlink, truncate, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { JsonValue, ObsLogEntry } from "@hns/core";
import {
  parseHealthResult,
  parseListResult,
  parseReadResult,
  parseStatResult,
} from "../../src/index.ts";
import type { ControlPlaneKeys, RefusalCode } from "../../src/index.ts";
import { controlPlaneKeys, generateControlPlaneKey } from "../support/control-plane.ts";
import { openSuspendedRequest, readAll, waitFor, withAgent } from "../support/machine.ts";
import type { MachineAnswer } from "../support/machine.ts";

/** The refusal code of an answer that must have been refused. */
function codeOf(answer: MachineAnswer): RefusalCode {
  if (answer.body.ok) throw new Error("expected a refusal");
  return answer.body.code;
}

/** The result of an answer that must have succeeded. */
function resultOf(answer: MachineAnswer): JsonValue {
  if (!answer.body.ok) throw new Error(`expected a result, got ${answer.body.code}`);
  return answer.body.result;
}

/** The host's first non-loopback IPv4 address, when it has one. */
function externalIpv4(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return undefined;
}

const health = JSON.stringify({ op: "health" });

test("a signed health call is answered", async () => {
  await withAgent(
    async () => {},
    async (fixture) => {
      const answer = await fixture.call({ body: health });

      expect(answer.status).toBe(200);
      expect(answer.body.ok).toBe(true);
      if (!answer.body.ok) return;
      expect(answer.body.op).toBe("health");
      const reported = parseHealthResult(answer.body.result);
      expect(reported.root).toBe(await realpath(fixture.root));
      expect(reported.pid).toBe(process.pid);
    },
  );
});

// Catches: the fs hop losing the Worker's correlation id or leaking the file content.
test("the request id and the fs path are logged without the content", async () => {
  const logs: ObsLogEntry[] = [];
  await withAgent(
    async ({ root }) => {
      await writeFile(join(root, "a.txt"), "super-secret-content");
    },
    async (fixture) => {
      // A leading separator is ROOT-relative on the wire; the log keeps exactly one.
      for (const path of ["a.txt", "/a.txt", "\\a.txt"]) {
        const before = logs.length;
        const answer = await fixture.call({
          body: JSON.stringify({ op: "read", path }),
          requestId: "corr-fs",
        });
        expect(answer.status, path).toBe(200);
        await waitFor(() => logs.length > before, "the fs log line");
        const line = logs.at(-1);
        expect(line, path).toMatchObject({
          event: "fs.op",
          hop: "fs",
          requestId: "corr-fs",
          path: "/a.txt",
          status: 200,
        });
        expect(JSON.stringify(line)).not.toContain("super-secret-content");
      }
    },
    { onLog: (entry) => logs.push(entry) },
  );
});

// Catches: the correlation header being treated as part of the signature or of authentication.
test("a malformed correlation header changes neither the answer nor the signature", async () => {
  const logs: ObsLogEntry[] = [];
  await withAgent(
    async () => {},
    async (fixture) => {
      const answer = await fixture.call({
        body: health,
        requestId: "bad id with spaces",
      });
      expect(answer.status).toBe(200);
      await waitFor(() => logs.length > 0, "the fs log line");
      expect(logs.at(-1)?.requestId).toBeNull();
    },
    { onLog: (entry) => logs.push(entry) },
  );
});

test("a request without a signature is refused", async () => {
  await withAgent(
    async () => {},
    async (fixture) => {
      const answer = await fixture.call({ body: health, unsigned: true });

      expect(answer.status).toBe(401);
      expect(codeOf(answer)).toBe("unauthorized");
    },
  );
});

test("a signature from another control-plane key is refused", async () => {
  await withAgent(
    async () => {},
    async (fixture) => {
      const other = generateControlPlaneKey();
      const answer = await fixture.call({ body: health, signingKey: other.privateKey });

      expect(answer.status).toBe(401);
      expect(codeOf(answer)).toBe("unauthorized");
    },
  );
});

test("a body swapped after signing is refused", async () => {
  await withAgent(
    async () => {},
    async (fixture) => {
      const answer = await fixture.call({
        body: JSON.stringify({ op: "read", path: "a.txt" }),
        signedBody: health,
      });

      expect(answer.status).toBe(401);
      expect(codeOf(answer)).toBe("unauthorized");
    },
  );
});

test("a stale timestamp is refused", async () => {
  await withAgent(
    async () => {},
    async (fixture) => {
      const past = await fixture.call({ body: health, timestamp: Date.now() - 10 * 60_000 });
      expect(past.status).toBe(401);
      expect(codeOf(past)).toBe("stale_request");
      const future = await fixture.call({ body: health, timestamp: Date.now() + 10 * 60_000 });
      expect(future.status).toBe(401);
      expect(codeOf(future)).toBe("stale_request");
    },
  );
});

test("a replayed nonce is refused", async () => {
  await withAgent(
    async () => {},
    async (fixture) => {
      const nonce = "replayed-nonce-0123456789";
      const first = await fixture.call({ body: health, nonce });
      expect(first.status).toBe(200);
      const second = await fixture.call({ body: health, nonce });
      expect(second.status).toBe(409);
      expect(codeOf(second)).toBe("replayed");
    },
  );
});

test("a verification that never finishes meets the deadline", async () => {
  const silent: ControlPlaneKeys = {
    publicKeys: () =>
      new Promise<readonly Uint8Array[]>(() => {
        // Never settles: only the request deadline can end this request.
      }),
  };
  await withAgent(
    async () => {},
    async (fixture) => {
      const first = await fixture.call({ body: health });
      expect(first.status).toBe(408);
      expect(codeOf(first)).toBe("deadline_exceeded");
      const second = await fixture.call({ body: health });
      expect(second.status).toBe(408);
      expect(codeOf(second)).toBe("deadline_exceeded");
      expect(fixture.agent.inFlight).toBe(0);
    },
    { controlPlane: silent, limits: { maxConcurrency: 1, timeoutMs: 100 } },
  );
});

test("an enrollment with no key is refused", async () => {
  await withAgent(
    async () => {},
    async (fixture) => {
      const answer = await fixture.call({ body: health });
      expect(answer.status).toBe(401);
      expect(codeOf(answer)).toBe("unauthorized");
    },
    { controlPlane: { publicKeys: async () => [] } },
  );
});

test("either key in a rotation is accepted", async () => {
  const oldKey = generateControlPlaneKey();
  const newKey = generateControlPlaneKey();
  const foreign = generateControlPlaneKey();
  await withAgent(
    async () => {},
    async (fixture) => {
      expect((await fixture.call({ body: health, signingKey: oldKey.privateKey })).status).toBe(
        200,
      );
      expect((await fixture.call({ body: health, signingKey: newKey.privateKey })).status).toBe(
        200,
      );
      const rejected = await fixture.call({ body: health, signingKey: foreign.privateKey });
      expect(rejected.status).toBe(401);
      expect(codeOf(rejected)).toBe("unauthorized");
    },
    { controlPlane: controlPlaneKeys([oldKey, newKey]), signingKey: newKey.privateKey },
  );
});

test("the machine's device key cannot sign an inbound request", async () => {
  // The device key authenticates machine -> Worker (0148); it is never an inbound credential.
  const deviceKey = generateControlPlaneKey();
  await withAgent(
    async () => {},
    async (fixture) => {
      const answer = await fixture.call({ body: health, signingKey: deviceKey.privateKey });
      expect(answer.status).toBe(401);
      expect(codeOf(answer)).toBe("unauthorized");
    },
  );
});

test("the older connection is refused after a newer one connects", async () => {
  await withAgent(
    async () => {},
    async (fixture) => {
      const older = { connection: "connection-1", seq: "1" };
      const newer = { connection: "connection-2", seq: "2" };
      expect((await fixture.call({ body: health, ...older })).status).toBe(200);
      expect((await fixture.call({ body: health, ...newer })).status).toBe(200);
      const stale = await fixture.call({ body: health, ...older });
      expect(stale.status).toBe(409);
      expect(codeOf(stale)).toBe("stale_connection");
      expect((await fixture.call({ body: health, ...newer })).status).toBe(200);
    },
  );
});

test("a parent segment and an absolute path never leave the root", async () => {
  await withAgent(
    async ({ base }) => {
      await writeFile(join(base, "outside.txt"), "outside");
    },
    async (fixture) => {
      const parent = await fixture.call({
        body: JSON.stringify({ op: "read", path: "../outside.txt" }),
      });
      expect(parent.status).toBe(400);
      expect(codeOf(parent)).toBe("path_denied");
      const nested = await fixture.call({
        body: JSON.stringify({ op: "read", path: "sub/../../outside.txt" }),
      });
      expect(nested.status).toBe(400);
      expect(codeOf(nested)).toBe("path_denied");
      const absolute = await fixture.call({
        body: JSON.stringify({ op: "read", path: "/etc/passwd" }),
      });
      expect(absolute.status).toBe(404);
      expect(codeOf(absolute)).toBe("not_found");
    },
  );
});

test("a symbolic link as a parent does not escape the root", async () => {
  await withAgent(
    async ({ root, base }) => {
      const outside = join(base, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "secret.txt"), "secret");
      await symlink(outside, join(root, "link"));
    },
    async (fixture) => {
      const answer = await fixture.call({
        body: JSON.stringify({ op: "read", path: "link/secret.txt" }),
      });
      expect(answer.status).toBe(400);
      expect(codeOf(answer)).toBe("path_denied");
    },
  );
});

test("a list does not follow a symbolic link", async () => {
  await withAgent(
    async ({ root, base }) => {
      const outside = join(base, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "secret.txt"), "secret");
      await symlink(outside, join(root, "link"));
    },
    async (fixture) => {
      const answer = await fixture.call({ body: JSON.stringify({ op: "list", path: "link" }) });
      expect(answer.status).toBe(403);
      expect(codeOf(answer)).toBe("forbidden");
      const followed = await fixture.call({
        body: JSON.stringify({ op: "list", path: "link/" }),
      });
      expect(followed.status).toBe(403);
      const stat = parseStatResult(
        resultOf(await fixture.call({ body: JSON.stringify({ op: "stat", path: "link" }) })),
      );
      expect(stat).toStrictEqual({
        exists: true,
        kind: "symlink",
        size: expect.any(Number),
        mtimeMs: expect.any(Number),
      });
    },
  );
});

test("a symbolic link as the final component is not followed", async () => {
  await withAgent(
    async ({ root, base }) => {
      const outside = join(base, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "secret.txt"), "secret");
      await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
    },
    async (fixture) => {
      const answer = await fixture.call({
        body: JSON.stringify({ op: "read", path: "escape.txt" }),
      });
      expect(answer.status).toBe(403);
      expect(codeOf(answer)).toBe("forbidden");
    },
  );
});

test("a socket is refused as a non-regular file", async () => {
  await withAgent(
    async () => {},
    async (fixture) => {
      const server = createServer();
      const socketPath = join(fixture.root, "agent.sock");
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      try {
        const answer = await fixture.call({
          body: JSON.stringify({ op: "read", path: "agent.sock" }),
        });
        expect(answer.status).toBe(400);
        expect(codeOf(answer)).toBe("invalid_request");
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
      }
    },
  );
});

test("reading and listing inside the root returns the bytes and their version", async () => {
  await withAgent(
    async ({ root }) => {
      await writeFile(join(root, "a.txt"), "hello");
      await mkdir(join(root, "sub"));
      await writeFile(join(root, "sub", "b.txt"), "world");
    },
    async (fixture) => {
      const read = await fixture.call({ body: JSON.stringify({ op: "read", path: "a.txt" }) });
      expect(read.status).toBe(200);
      const content = parseReadResult(resultOf(read));
      expect(content.path).toBe("a.txt");
      expect(content.size).toBe(5);
      expect(Buffer.from(content.content, "base64").toString("utf8")).toBe("hello");
      expect(content.version).toBe("sha256:" + createHash("sha256").update("hello").digest("hex"));

      const present = parseStatResult(
        resultOf(await fixture.call({ body: JSON.stringify({ op: "stat", path: "a.txt" }) })),
      );
      expect(present).toStrictEqual({
        exists: true,
        kind: "file",
        size: 5,
        mtimeMs: expect.any(Number),
      });

      const absent = parseStatResult(
        resultOf(await fixture.call({ body: JSON.stringify({ op: "stat", path: "missing.txt" }) })),
      );
      expect(absent).toStrictEqual({ exists: false });

      const listing = parseListResult(
        resultOf(await fixture.call({ body: JSON.stringify({ op: "list", path: "" }) })),
      );
      expect(listing.entries.map((entry) => entry.name).sort()).toStrictEqual(["a.txt", "sub"]);
      expect(listing.entries.find((entry) => entry.name === "sub")?.kind).toBe("directory");
      const nested = parseListResult(
        resultOf(await fixture.call({ body: JSON.stringify({ op: "list", path: "sub" }) })),
      );
      expect(nested.entries).toStrictEqual([{ name: "b.txt", kind: "file" }]);
    },
  );
});

test("a request beyond the concurrency limit is refused", async () => {
  await withAgent(
    async () => {},
    async (fixture) => {
      const held = await openSuspendedRequest(fixture.port, "{");
      try {
        await waitFor(() => fixture.agent.inFlight === 1, "the held request to take the slot");
        const busy = await fixture.call({ body: health });
        expect(busy.status).toBe(429);
        expect(codeOf(busy)).toBe("busy");
        const refused = await readAll(held);
        expect(refused).toContain("408");
        await waitFor(() => fixture.agent.inFlight === 0, "the slot to be released");
        expect((await fixture.call({ body: health })).status).toBe(200);
      } finally {
        held.destroy();
      }
    },
    { limits: { maxConcurrency: 1, timeoutMs: 300 } },
  );
});

test("a slow read holds its slot until it finishes", async () => {
  await withAgent(
    async ({ root }) => {
      await writeFile(join(root, "big.bin"), "");
      await truncate(join(root, "big.bin"), 16 * 1024 * 1024);
    },
    async (fixture) => {
      const slow = fixture.call({ body: JSON.stringify({ op: "read", path: "big.bin" }) });
      await waitFor(() => fixture.agent.inFlight === 1, "the slow read to take the slot");
      const busy = await fixture.call({ body: health });
      expect(busy.status).toBe(429);
      expect(codeOf(busy)).toBe("busy");
      const finished = await slow;
      expect(finished.status).toBe(200);
      await waitFor(() => fixture.agent.inFlight === 0, "the slot to be released");
      expect((await fixture.call({ body: health })).status).toBe(200);
    },
    {
      limits: {
        maxConcurrency: 1,
        timeoutMs: 5_000,
        maxResponseBytes: 32 * 1024 * 1024,
      },
    },
  );
});

test("a read that outlives the deadline is aborted", async () => {
  await withAgent(
    async ({ root }) => {
      await writeFile(join(root, "big.bin"), "");
      await truncate(join(root, "big.bin"), 64 * 1024 * 1024);
    },
    async (fixture) => {
      const slow = await fixture.call({ body: JSON.stringify({ op: "read", path: "big.bin" }) });
      expect(slow.status).toBe(408);
      expect(codeOf(slow)).toBe("deadline_exceeded");
      await waitFor(() => fixture.agent.inFlight === 0, "the slot to be released");
    },
    {
      limits: {
        maxConcurrency: 1,
        timeoutMs: 2,
        maxResponseBytes: 128 * 1024 * 1024,
      },
    },
  );
});

test("a body over the request limit is refused", async () => {
  await withAgent(
    async () => {},
    async (fixture) => {
      const answer = await fixture.call({
        body: JSON.stringify({ op: "read", path: "a".repeat(200) }),
      });
      expect(answer.status).toBe(413);
      expect(codeOf(answer)).toBe("too_large");
    },
    { limits: { maxRequestBytes: 64 } },
  );
});

test("a response over the output limit is refused", async () => {
  await withAgent(
    async ({ root }) => {
      await writeFile(join(root, "large.txt"), "x".repeat(400));
      for (let index = 0; index < 30; index += 1) {
        await writeFile(join(root, `entry-${index}-${"z".repeat(20)}.txt`), "");
      }
    },
    async (fixture) => {
      const large = await fixture.call({
        body: JSON.stringify({ op: "read", path: "large.txt" }),
      });
      expect(large.status).toBe(413);
      expect(codeOf(large)).toBe("too_large");
      const listing = await fixture.call({ body: JSON.stringify({ op: "list", path: "" }) });
      expect(listing.status).toBe(413);
      expect(codeOf(listing)).toBe("too_large");
    },
    { limits: { maxResponseBytes: 200 } },
  );
});

test("a FIFO is refused without blocking the pool", async () => {
  await withAgent(
    async ({ root }) => {
      await writeFile(join(root, "a.txt"), "hello");
      for (let index = 0; index < 8; index += 1) {
        execFileSync("mkfifo", [join(root, `pipe-${index}`)]);
      }
    },
    async (fixture) => {
      const reads = Array.from({ length: 8 }, (_, index) =>
        fixture.call({ body: JSON.stringify({ op: "read", path: `pipe-${index}` }) }),
      );
      const answers = await Promise.all(reads);
      for (const answer of answers) {
        expect(answer.status).toBe(400);
        expect(codeOf(answer)).toBe("invalid_request");
      }
      const after = await fixture.call({ body: JSON.stringify({ op: "read", path: "a.txt" }) });
      expect(after.status).toBe(200);
      const content = parseReadResult(resultOf(after));
      expect(Buffer.from(content.content, "base64").toString("utf8")).toBe("hello");
      await waitFor(() => fixture.agent.inFlight === 0, "the slots to be released");
    },
    { limits: { timeoutMs: 2_000 } },
  );
});

test("a request that never finishes its body meets the deadline", async () => {
  await withAgent(
    async () => {},
    async (fixture) => {
      const held = await openSuspendedRequest(fixture.port, "{");
      try {
        const response = await readAll(held);
        expect(response).toContain("408");
        expect(response).toContain("deadline_exceeded");
      } finally {
        held.destroy();
      }
    },
    { limits: { timeoutMs: 100 } },
  );
});

test("the agent binds to loopback only", async () => {
  await withAgent(
    async () => {},
    async (fixture) => {
      expect(fixture.agent.address).toBe("127.0.0.1");
      expect(fixture.origin).toBe(`http://127.0.0.1:${fixture.port}`);
      expect(fixture.port).toBeGreaterThan(0);
    },
  );
});

test("a non-loopback interface cannot reach the agent", async (context) => {
  const external = externalIpv4();
  if (external === undefined) {
    context.skip("this host has no non-loopback IPv4 interface to try");
    return;
  }
  await withAgent(
    async () => {},
    async (fixture) => {
      await expect(
        fetch(`http://${external}:${fixture.port}/rpc`, { method: "POST", body: "{}" }),
      ).rejects.toThrow();
    },
  );
});

test("a wrong method and a wrong route are refused distinctly", async () => {
  await withAgent(
    async () => {},
    async (fixture) => {
      const get = await fixture.call({ body: "", method: "GET" });
      expect(get.status).toBe(405);
      expect(codeOf(get)).toBe("method_not_allowed");
      expect(get.headers.get("allow")).toBe("POST");
      const other = await fixture.call({ body: "{}", path: "/other" });
      expect(other.status).toBe(404);
      expect(codeOf(other)).toBe("not_found");
    },
  );
});

test("an unknown operation is refused as an invalid request", async () => {
  await withAgent(
    async () => {},
    async (fixture) => {
      const answer = await fixture.call({ body: JSON.stringify({ op: "bash", command: "id" }) });
      expect(answer.status).toBe(400);
      expect(codeOf(answer)).toBe("invalid_request");
    },
  );
});
