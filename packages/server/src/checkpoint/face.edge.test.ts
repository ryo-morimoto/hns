import { openStore } from "@hns/store";
import { expect, test } from "vitest";
import * as v from "valibot";
import type { DurableObjectNamespace } from "../edge/env.ts";
import { createEdge, type HandlerDependencies } from "../edge/handler.ts";
import { openFakeD1 } from "../../test/support/d1.ts";
import { envWith, sessionCookie } from "../../test/support/edge.ts";
import { createCheckpointFace } from "./face.ts";

/**
 * The checkpoint face **through the edge**: routing, authentication, method, and the handler
 * itself, with the real face wired in.
 *
 * @remarks
 * `face.test.ts` calls the face directly, so it cannot see the edge's decisions. This file
 * builds the edge the Worker builds (`createEdge` with `createCheckpointFace()`) and sends real
 * requests at `/api/workspaces/<id>/checkpoints/...`, so the route match, the 401 before
 * anything else, the 405 with `allow: POST`, the missing dependency, and the face's own 404 and
 * 200 are all fixed by a test. Breaking any of them fails here.
 *
 * There is no Worker-runtime pool in this repository (@cloudflare/vitest-pool-workers), and the
 * cf dev suites run one at a time; the real workerd path is proved by
 * `test/integration/workspace-do.test.ts` instead.
 */

const BASE = "https://hns.test";

/** A Workspace namespace whose stub records requests and answers one fixed response. */
interface Forwarded {
  readonly namespace: DurableObjectNamespace;
  readonly requests: Request[];
}

function workspaceWith(response: () => Response): Forwarded {
  const requests: Request[] = [];
  return {
    requests,
    namespace: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch(request: Request): Promise<Response> {
          requests.push(request);
          return Promise.resolve(response());
        },
      }),
    },
  };
}

/** A D1 with one project created through the store, so the face's lookup is the real one. */
async function d1WithProject(): Promise<ReturnType<typeof openFakeD1>> {
  const d1 = openFakeD1();
  const store = await openStore({ d1: d1.db, newId: () => "w1" });
  try {
    await store.projects.create("w1", "projects/w1");
  } finally {
    await store.close();
  }
  return d1;
}

/** The edge's dependencies: the real checkpoint face, and stubs for the faces it does not use. */
function edgeDeps(checkpoints: HandlerDependencies["checkpoints"]): HandlerDependencies {
  return {
    graphql: () => Promise.resolve(new Response("graphql")),
    ws: () => Promise.resolve(new Response("ws")),
    checkpoints,
  };
}

/** A request with a JSON body, and a session unless asked not to have one. */
async function jsonPost(path: string, body: string, signed = true): Promise<Request> {
  const headers: HeadersInit = { "content-type": "application/json" };
  const request = new Request(BASE + path, { method: "POST", body, headers });
  if (signed) request.headers.set("cookie", await sessionCookie("owner"));
  return request;
}

/** A request with the cookies of a signed-in browser, if asked. */
async function withSession(request: Request, signed = true): Promise<Request> {
  const headers = new Headers(request.headers);
  if (signed) headers.set("cookie", await sessionCookie("owner"));
  return new Request(request, { headers });
}

/** The problem+json code of a refused edge request. */
async function codeOf(response: Response): Promise<string> {
  const body = v.parse(v.object({ code: v.string() }), await response.json());
  return body.code;
}

// Catches: the checkpoint route answering before authentication, or an anonymous caller learning
// the route's method or body rules, which every face of the edge denies first (D059).
test("the checkpoint route is a 401 for every method without a session", async () => {
  const forward = workspaceWith(() => new Response("{}", { status: 200 }));
  const d1 = await d1WithProject();
  try {
    const edge = createEdge(edgeDeps(createCheckpointFace()));
    const env = envWith({ workspace: forward.namespace, db: d1.db });
    const prepare = new Request(BASE + "/api/workspaces/w1/checkpoints/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"runId":"run-1"}',
    });
    const pack = new Request(BASE + "/api/workspaces/w1/checkpoints/run-1/pack", {
      method: "POST",
      headers: { "content-type": "application/x-git-pack", "content-length": "1" },
      body: "x",
    });
    const getPrepare = new Request(BASE + "/api/workspaces/w1/checkpoints/prepare");
    for (const request of [prepare, pack, getPrepare]) {
      const response = await edge(request, env);
      expect(response.status, request.method + " " + new URL(request.url).pathname).toBe(401);
      expect(await codeOf(response)).toBe("unauthorized");
    }
    expect(forward.requests).toStrictEqual([]);
  } finally {
    d1.close();
  }
});

// Catches: a checkpoint path outside the route pattern (answered as a static asset or a 404 that
// also hides a misspelt route), so the face never runs for it.
test("the checkpoint path is a face for every action the object answers", async () => {
  const forward = workspaceWith(
    () => new Response(JSON.stringify({ ok: true, checkpoint: {} }), { status: 200 }),
  );
  const d1 = await d1WithProject();
  try {
    const edge = createEdge(edgeDeps(createCheckpointFace()));
    const env = envWith({ workspace: forward.namespace, db: d1.db });
    const prepare = await edge(
      await jsonPost("/api/workspaces/w1/checkpoints/prepare", '{"runId":"run-1"}'),
      env,
    );
    expect(prepare.status, await prepare.clone().text()).toBe(200);
    expect(await prepare.json()).toStrictEqual({ ok: true, checkpoint: {} });
    expect(forward.requests).toHaveLength(1);
    expect(forward.requests[0]?.url).toBe("https://workspace.internal/rpc/checkpoint/prepare");
  } finally {
    d1.close();
  }
});

// Catches: a method other than POST reaching the face (and the object), or the 405 losing the
// Allow header a client needs to correct itself.
test("a non-POST method is a 405 with allow: POST", async () => {
  const forward = workspaceWith(() => new Response("{}", { status: 200 }));
  const d1 = await d1WithProject();
  try {
    const edge = createEdge(edgeDeps(createCheckpointFace()));
    const env = envWith({ workspace: forward.namespace, db: d1.db });
    for (const method of ["GET", "DELETE"] as const) {
      const request = await withSession(
        new Request(BASE + "/api/workspaces/w1/checkpoints/prepare", { method }),
      );
      const response = await edge(request, env);
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(await codeOf(response)).toBe("method_not_allowed");
    }
    expect(forward.requests).toStrictEqual([]);
  } finally {
    d1.close();
  }
});

// Catches: a deployment without the face answering as if the route did not exist (404) or
// crashing, instead of failing closed with a 503 a client can retry.
test("a missing checkpoint dependency is a 503", async () => {
  const d1 = await d1WithProject();
  try {
    const edge = createEdge(edgeDeps(undefined));
    const env = envWith({ db: d1.db });
    const response = await edge(
      await jsonPost("/api/workspaces/w1/checkpoints/prepare", '{"runId":"run-1"}'),
      env,
    );
    expect(response.status).toBe(503);
    expect(await codeOf(response)).toBe("unavailable");
  } finally {
    d1.close();
  }
});

// Catches: an unknown workspace reaching the object (which would create it) or answering a 200.
test("an unknown workspace is a 404", async () => {
  const forward = workspaceWith(() => new Response("{}", { status: 200 }));
  const d1 = await d1WithProject();
  try {
    const edge = createEdge(edgeDeps(createCheckpointFace()));
    const env = envWith({ workspace: forward.namespace, db: d1.db });
    const response = await edge(
      await jsonPost("/api/workspaces/nope/checkpoints/prepare", '{"runId":"run-1"}'),
      env,
    );
    expect(response.status).toBe(404);
    expect(await codeOf(response)).toBe("not_found");
    expect(forward.requests).toStrictEqual([]);
  } finally {
    d1.close();
  }
});

// Catches: the face's answer being wrapped or re-spelt on the way out, so a client sees another
// status than the one the Workspace object chose.
test("the object's answer passes through with its own status and code", async () => {
  const forward = workspaceWith(
    () =>
      new Response(JSON.stringify({ ok: false, code: "conflict", message: "no pack" }), {
        status: 409,
      }),
  );
  const d1 = await d1WithProject();
  try {
    const edge = createEdge(edgeDeps(createCheckpointFace()));
    const env = envWith({ workspace: forward.namespace, db: d1.db });
    const response = await edge(
      await jsonPost("/api/workspaces/w1/checkpoints/complete", '{"runId":"run-1","throughSeq":3}'),
      env,
    );
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await codeOf(response)).toBe("conflict");
  } finally {
    d1.close();
  }
});
