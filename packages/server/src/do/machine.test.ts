import { generateKeyPairSync } from "node:crypto";
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
  const answer = await client().read({ path: "a.txt" }, call);
  if (answer.ok) throw new Error("expected no usable answer");
  expect(answer.failure).toBe("unavailable");
  expect(answer.detail).toBe("answer too large");
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
