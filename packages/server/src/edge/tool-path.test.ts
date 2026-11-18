import { expect, test } from "vitest";
import worker from "./worker.ts";
import { envWith, sessionCookie, sessionWith } from "../../test/support/edge.ts";

/**
 * (c) 0270n: the edge answers a partly configured deployment with one 503 on every face.
 *
 * @remarks
 * The granted tool path is opened by three bindings together. A deployment that sets two of them
 * would otherwise serve every face in a state the operator did not ask for; the edge refuses the
 * whole request before authentication. The test walks **two** faces with different auth
 * requirements (`/graphql` and `/api/machines/keys`) so the refusal is not one route's accident, and
 * checks the answer names the missing bindings and never their values.
 */

const BASE = "https://hns.test";

/**
 * An environment with two of the three tool-path bindings: the dangerous half-state.
 *
 * @param options - The other bindings a face needs, as `envWith` takes them.
 */
function halfConfigured(options: Parameters<typeof envWith>[0] = {}) {
  return {
    ...envWith(options),
    HNS_AGENT_URL: "https://machine.example",
    HNS_CONTROL_PLANE_KEY: "a-secret-seed-must-not-appear",
  };
}

// Catches: `/graphql` running (and an operator reading a normal 200) while the granted path is half
// configured.
test("graphql is unavailable when the tool-path bindings are partly configured", async () => {
  const cookie = await sessionCookie("owner");
  const response = await worker.fetch(
    new Request(BASE + "/graphql", {
      method: "POST",
      body: JSON.stringify({ query: "{ projects { __typename } }" }),
      headers: { "content-type": "application/json", cookie },
    }),
    halfConfigured({}),
  );
  expect(response.status).toBe(503);
  // SAFETY: the edge answers problem+json for a refused request (the shape `src/edge/problem.ts`
  // builds); this reads the two members the assertion is about.
  const body = (await response.json()) as { code?: string; detail?: string };
  expect(body.code).toBe("unavailable");
  expect(body.detail).toContain("HNS_MACHINE_ID");
  expect(body.detail).not.toContain("a-secret-seed-must-not-appear");
});

// Catches: the machines face (a different handler, a different auth path) passing while the rest is
// refused: a half-configured deployment must not look half-up.
test("the machine key face is unavailable when the tool-path bindings are partly configured", async () => {
  const cookie = await sessionCookie("owner");
  const session = sessionWith();
  const response = await worker.fetch(
    new Request(BASE + "/api/machines/keys", { headers: { cookie } }),
    halfConfigured({ session: session.namespace }),
  );
  expect(response.status).toBe(503);
  // SAFETY: the edge answers problem+json for a refused request; this reads the one member the
  // assertion is about.
  const body = (await response.json()) as { code?: string };
  expect(body.code).toBe("unavailable");
  // No face handled the request: the only traffic to the Session object is the edge's own
  // observability line (onResponse), which is not a face and records the 503.
  expect(session.requests.map((request) => new URL(request.url).pathname)).toStrictEqual([
    "/rpc/events",
  ]);
});

// Catches: the check refusing a deployment that deliberately keeps the Phase 0 tools (none of the
// three), which is the only other state the object opens in.
test("a deployment with none of the tool-path bindings still serves graphql", async () => {
  const cookie = await sessionCookie("owner");
  const response = await worker.fetch(
    new Request(BASE + "/graphql", {
      method: "POST",
      body: JSON.stringify({ query: "{ projects { __typename } }" }),
      headers: { "content-type": "application/json", cookie },
    }),
    envWith(),
  );
  expect(response.status).toBe(200);
});
