import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@hns/core";
import {
  parseHealthResult,
  parseListResult,
  parseReadResult,
  parseStatResult,
} from "../../src/index.ts";
import type { RefusalCode } from "../../src/index.ts";
import { generateMachineKeys } from "../support/keys.ts";
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

test("a signature from another key is refused", async () => {
  await withAgent(
    async () => {},
    async (fixture) => {
      const other = generateMachineKeys("machine-2");
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

test("an unregistered machine is refused", async () => {
  await withAgent(
    async () => {},
    async (fixture) => {
      const answer = await fixture.call({ body: health });
      expect(answer.status).toBe(401);
      expect(codeOf(answer)).toBe("unauthorized");
    },
    { registry: { publicKey: async () => undefined } },
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

test("the agent listens on loopback only", async () => {
  await withAgent(
    async () => {},
    async (fixture) => {
      expect(fixture.origin).toBe(`http://127.0.0.1:${fixture.port}`);
      expect(fixture.port).toBeGreaterThan(0);
      const external = Object.values(networkInterfaces())
        .flat()
        .find((info) => info !== undefined && info.family === "IPv4" && !info.internal);
      if (external === undefined) return;
      await expect(
        fetch(`http://${external.address}:${fixture.port}/rpc`, { method: "POST", body: "{}" }),
      ).rejects.toThrow();
    },
  );
});

test("a request that is not POST /rpc is not found", async () => {
  await withAgent(
    async () => {},
    async (fixture) => {
      const get = await fixture.call({ body: "", method: "GET" });
      expect(get.status).toBe(404);
      expect(codeOf(get)).toBe("not_found");
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
