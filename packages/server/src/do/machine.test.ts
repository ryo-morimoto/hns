import { generateKeyPairSync } from "node:crypto";
import { isoTimestamp, type JsonValue, type MirrorTarget } from "@hns/core";
import { afterEach, expect, test, vi } from "vitest";
import * as v from "valibot";
import { createSignedMachineFiles, type MachineCall } from "./machine.ts";

/** A base64url Ed25519 seed, the Worker secret's shape. */
function controlPlaneKey(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return v.parse(
    v.object({ d: v.pipe(v.string(), v.minLength(1)) }),
    privateKey.export({ format: "jwk" }),
  ).d;
}

const call: MachineCall = {
  machineId: "machine-1",
  requestId: "request-1",
  signal: new AbortController().signal,
};

/** The client under test, pointed at a URL the stubbed fetch ignores. */
function client() {
  return createSignedMachineFiles({
    agentUrl: "http://127.0.0.1:8788",
    controlPlaneKey: controlPlaneKey(),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Catches: an answer body that fails while it is read being reported as an answer.
test("an answer whose body cannot be read is unavailable", async () => {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("the connection was cut"));
          },
        }),
      ),
    ),
  );
  const answer = await client().read({ path: "a.txt" }, call);
  if (answer.ok) throw new Error("expected no usable answer");
  expect(answer.failure).toBe("unavailable");
});

// Catches: a malformed or oversized answer being materialized and read as a result.
test("an oversized answer is unavailable", async () => {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(new Response("x".repeat(1_048_577), { status: 200 })),
  );
  // A body without a usable content-length is cut off while it streams.
  const streamed = await client().read({ path: "a.txt" }, call);
  if (streamed.ok) throw new Error("expected no usable answer");
  expect(streamed.failure).toBe("unavailable");
  expect(streamed.detail).toBe("unreadable or oversized answer");

  // A declared oversize is refused before the body is read at all.
  vi.stubGlobal("fetch", () =>
    Promise.resolve(new Response("x", { status: 200, headers: { "content-length": "2000000" } })),
  );
  const declared = await client().read({ path: "a.txt" }, call);
  if (declared.ok) throw new Error("expected no usable answer");
  expect(declared.detail).toBe("answer too large");
});

// Catches: the machine's own size refusal being folded into "denied" (or into a missing file).
test("a too-large refusal keeps its own failure", async () => {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: false, code: "too_large", message: "too large" }), {
        status: 413,
      }),
    ),
  );
  const answer = await client().read({ path: "a.txt" }, call);
  if (answer.ok) throw new Error("expected no usable answer");
  expect(answer.failure).toBe("too_large");
  expect(answer.detail).toBe("too_large");
});

// Catches: a definite refusal such as a denied path being retried as if it were a transport
// failure, and an authentication failure being reported as the machine's denial.
test("a definite refusal is denied and an authentication failure is unavailable", async () => {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: false, code: "path_denied", message: "no" }), {
        status: 400,
      }),
    ),
  );
  const denied = await client().read({ path: "a.txt" }, call);
  if (denied.ok) throw new Error("expected no usable answer");
  expect(denied.failure).toBe("denied");

  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: false, code: "unauthorized", message: "no" }), {
        status: 401,
      }),
    ),
  );
  const unauthenticated = await client().read({ path: "a.txt" }, call);
  if (unauthenticated.ok) throw new Error("expected no usable answer");
  expect(unauthenticated.failure).toBe("unavailable");
});

/** The target one prepare issues, as the machine's contract carries it (0246). */
const target: MirrorTarget = {
  remote: "https://git.example/git/ns/ws-w1.git",
  token: "art_v2_x_secret_0272",
  ref: "refs/heads/hns/run/run-1",
  expiresAt: isoTimestamp("2026-11-18T00:15:00.000Z"),
};

/** Answer every fetch with one body, and record the request it was sent. */
function answerWith(body: JsonValue, status = 200) {
  const sent: Request[] = [];
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    sent.push(new Request(_url, init));
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  });
  return sent;
}

// Catches: a mirror request that is not the machine's `op:"mirror"`, or one whose token would
// leave the signed body (the agent reads the operation and the credential from the body it).
test("the mirror push is the machine's op request, with the token in the signed body only", async () => {
  const sent = answerWith({
    ok: true,
    op: "mirror",
    result: { status: "mirrored", ref: target.ref, commit: "a".repeat(40) },
  });
  const answer = await client().mirror?.({ runId: "run-1", commit: "a".repeat(40), target }, call);
  expect(answer).toStrictEqual({
    ok: true,
    status: "mirrored",
    ref: target.ref,
    commit: "a".repeat(40),
  });
  expect(sent).toHaveLength(1);
  const request = sent[0];
  if (request === undefined) throw new Error("no request was sent");
  expect(request.url).toBe("http://127.0.0.1:8788/rpc");
  const body = v.parse(
    v.object({
      op: v.literal("mirror"),
      runId: v.string(),
      remote: v.string(),
      token: v.string(),
      ref: v.string(),
      commit: v.string(),
      expiresAt: v.string(),
    }),
    JSON.parse(await request.text()),
  );
  expect(body.op).toBe("mirror");
  expect(body.runId).toBe("run-1");
  expect(body.ref).toBe(target.ref);
  // The credential is the body's, never a header: the agent's log redacts the body's token, and
  // nothing here can put it somewhere else.
  for (const [, value] of request.headers) expect(value).not.toContain(target.token);
});

// Catches: a machine that says "mirrored" being recorded as a success by the transport (the
// Worker's confirmation through the binding is the route's, not this client's), and a refusal or
// a lost answer being rounded into a status the machine did not say.
test("every mirror answer is a value: skipped, failed, a refusal, and no answer", async () => {
  answerWith({ ok: true, op: "mirror", result: { status: "skipped", reason: "too_large" } });
  expect(
    await client().mirror?.({ runId: "run-1", commit: "a".repeat(40), target }, call),
  ).toStrictEqual({ ok: true, status: "skipped", reason: "too_large" });
  answerWith({
    ok: true,
    op: "mirror",
    result: { status: "failed", failure: "push_rejected", ref: target.ref },
  });
  expect(
    await client().mirror?.({ runId: "run-1", commit: "a".repeat(40), target }, call),
  ).toStrictEqual({ ok: true, status: "failed", failure: "push_rejected", ref: target.ref });
  // The machine's own definite refusal keeps its code (the Workspace records it as
  // `push_rejected`); a refusal it cannot act on (`busy`: the machine was already working) is
  // "no answer" and is recorded as `network`, the same split every machine call makes.
  answerWith({ ok: false, code: "path_denied", message: "path_denied" }, 400);
  expect(
    await client().mirror?.({ runId: "run-1", commit: "a".repeat(40), target }, call),
  ).toStrictEqual({ ok: false, failure: "refused", detail: "path_denied" });
  answerWith({ ok: false, code: "busy", message: "busy" }, 429);
  const busy = await client().mirror?.({ runId: "run-1", commit: "a".repeat(40), target }, call);
  if (busy === undefined || busy.ok) throw new Error("expected no status");
  expect(busy.failure).toBe("unavailable");
  expect(busy.detail).toBe("busy");
  vi.stubGlobal("fetch", () => Promise.reject(new Error("the tunnel is closed")));
  const lost = await client().mirror?.({ runId: "run-1", commit: "a".repeat(40), target }, call);
  if (lost === undefined || lost.ok) throw new Error("expected no status");
  expect(lost.failure).toBe("unavailable");
  // A body that is not the contract's status is no answer, not a guess.
  answerWith({ ok: true, op: "mirror", result: { status: "done" } });
  const odd = await client().mirror?.({ runId: "run-1", commit: "a".repeat(40), target }, call);
  if (odd === undefined || odd.ok) throw new Error("expected no status");
  expect(odd.detail).toBe("unparseable mirror result");
});
