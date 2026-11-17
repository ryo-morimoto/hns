import * as v from "valibot";
import { expect, test } from "vitest";
import { envWith, sessionCookie, TEST_SECRET } from "../../test/support/edge.ts";
import type { WorkerEnv } from "../edge/env.ts";
import { createEdge, type HandlerDependencies } from "../edge/handler.ts";
import { createKeysFace } from "./keys.ts";

/**
 * `GET /api/machines/keys` (0148 / D087): the control-plane public key, served to a session only.
 *
 * @remarks
 * The keys are public, but the deployment they name is not (D059): the edge answers 401 before the
 * face runs, so an unauthenticated caller learns nothing. The body carries the public half and
 * never the seed.
 */

const BASE = "https://hns.test";
const SEED = Buffer.from(new Uint8Array(32).fill(5)).toString("base64url");

/** An environment with the session secret and, optionally, a control-plane seed. */
function envWithKey(seed?: string): WorkerEnv {
  const base = envWith({ secret: TEST_SECRET });
  return seed === undefined ? base : { ...base, HNS_CONTROL_PLANE_KEY: seed };
}

/** Dependencies with only the keys face wired. */
function deps(keys: HandlerDependencies["machineKeys"]): HandlerDependencies {
  const unused = (): Promise<Response> => Promise.resolve(new Response("unused"));
  return { graphql: unused, ws: unused, machineKeys: keys };
}

function get(headers: Record<string, string> = {}): Request {
  return new Request(BASE + "/api/machines/keys", { headers });
}

// Catches: key material reachable without a session.
test("an unauthenticated keys request is 401 and the face never runs", async () => {
  let calls = 0;
  const edge = createEdge(
    deps(async () => {
      calls += 1;
      return new Response("{}");
    }),
  );
  const response = await edge(get(), envWithKey(SEED));
  expect(response.status).toBe(401);
  expect(calls).toBe(0);
});

// Catches: the seed appearing in the response.
test("the keys body carries the public half, not the seed", async () => {
  const edge = createEdge(deps(createKeysFace()));
  const response = await edge(get({ cookie: await sessionCookie() }), envWithKey(SEED));
  expect(response.status).toBe(200);
  const body = v.parse(
    v.object({
      keys: v.array(v.object({ publicKey: v.string(), algorithm: v.string() })),
    }),
    await response.json(),
  );
  expect(body.keys).toHaveLength(1);
  expect(body.keys[0]?.algorithm).toBe("ed25519");
  expect(body.keys[0]?.publicKey).not.toBe(SEED);
  expect(JSON.stringify(body)).not.toContain(SEED);
});

// Catches: a deployment with no key answering 200 with an empty list, which a machine would read
// as "enrolled with no key".
test("a missing or malformed control-plane key is a typed unavailable", async () => {
  const edge = createEdge(deps(createKeysFace()));
  for (const env of [envWithKey(), envWithKey("short"), envWithKey("not base64url!")]) {
    const response = await edge(get({ cookie: await sessionCookie() }), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "unavailable" });
  }
});

// Catches: a POST that reaches the face instead of a typed 405.
test("a non-GET method is 405 with allow: GET", async () => {
  const edge = createEdge(deps(createKeysFace()));
  const response = await edge(
    new Request(BASE + "/api/machines/keys", {
      method: "POST",
      headers: { cookie: await sessionCookie() },
    }),
    envWithKey(SEED),
  );
  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("GET");
});

// Catches: a route that is not wired, which would answer 404 instead of the face's 503.
test("a missing machineKeys face is 503, not 404", async () => {
  const edge = createEdge({
    graphql: () => Promise.resolve(new Response()),
    ws: () => Promise.resolve(new Response()),
  });
  const response = await edge(get({ cookie: await sessionCookie() }), envWithKey(SEED));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "unavailable" });
});
