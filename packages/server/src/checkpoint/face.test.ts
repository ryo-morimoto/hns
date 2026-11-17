import { expect, test } from "vitest";
import { createCheckpointFace } from "./face.ts";
import type { CheckpointRequest } from "../edge/handler.ts";
import type { DurableObjectNamespace } from "../edge/env.ts";
import { openStore } from "@hns/store";
import { openFakeD1 } from "../../../store/test/support/fake-d1.ts";
import { envWith, sessionCookie } from "../../test/support/edge.ts";

const BASE = "https://hns.test";

/** A Workspace namespace whose stub records what it was asked and answers with the object's. */
interface Forwarded {
  readonly namespace: DurableObjectNamespace;
  readonly requests: Request[];
}

function workspaceWith(answer: (request: Request) => Response): Forwarded {
  const requests: Request[] = [];
  return {
    requests,
    namespace: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch(request: Request): Promise<Response> {
          requests.push(request);
          return Promise.resolve(answer(request));
        },
      }),
    },
  };
}

/** A fake D1 opened through the store, with one project created: the face's lookup is real. */
async function d1WithProject(
  id = "w1",
  workspaceRoot = "projects/" + id,
): Promise<ReturnType<typeof openFakeD1>> {
  const d1 = openFakeD1();
  const store = await openStore({ d1: d1.db, newId: () => id });
  try {
    await store.projects.create(id, workspaceRoot);
  } finally {
    await store.close();
  }
  return d1;
}

function post(path: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(BASE + path, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function checkpointRequest(request: Request, id = "w1"): Promise<CheckpointRequest> {
  const cookie = await sessionCookie("owner");
  const headers = new Headers(request.headers);
  headers.set("cookie", cookie);
  const signed = new Request(request, { headers });
  return {
    request: signed,
    env: envWith(),
    session: { subject: "owner", expiresAt: Math.floor(Date.now() / 1000) + 60 },
    requestId: "req-1",
    signal: new AbortController().signal,
    workspaceId: id,
    limits: {
      maxBodyBytes: 1_048_576,
      maxRequestMs: 10_000,
      maxRowsPerRequest: 500,
      maxRowsPerList: 100,
      maxPackBytes: 64 * 1024 * 1024,
    },
  };
}

// Catches: a prepare that is forwarded without the workspace the path names, so the object
// would answer for another workspace.
test("prepare forwards the workspace and the Run to the object", async () => {
  const forward = workspaceWith(
    () =>
      new Response(JSON.stringify({ ok: true, checkpoint: { runId: "run-1" } }), { status: 200 }),
  );
  const d1 = await d1WithProject();
  try {
    const face = createCheckpointFace();
    const request = await checkpointRequest(
      post("/api/workspaces/w1/checkpoints/prepare", '{"runId":"run-1"}'),
    );
    const response = await face({
      ...request,
      env: envWith({ workspace: forward.namespace, db: d1.db }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ ok: true, checkpoint: { runId: "run-1" } });
    const forwarded = forward.requests[0];
    expect(forwarded?.url).toBe("https://workspace.internal/rpc/checkpoint/prepare");
    expect(await forwarded?.json()).toStrictEqual({ workspaceId: "w1", runId: "run-1" });
  } finally {
    d1.close();
  }
});

// Catches: a pack body being parsed as JSON or re-encoded, so the bytes the object verifies are
// not the bytes the machine signed; or the signed headers being dropped in the forward.
test("a pack is forwarded byte for byte with its signed headers", async () => {
  const forward = workspaceWith(
    () => new Response(JSON.stringify({ ok: true, runId: "run-1" }), { status: 200 }),
  );
  const d1 = await d1WithProject();
  try {
    const face = createCheckpointFace();
    const bytes = new Uint8Array(8).fill(7);
    const request = await checkpointRequest(
      new Request(BASE + "/api/workspaces/w1/checkpoints/run-1/pack", {
        method: "POST",
        headers: {
          "content-type": "application/x-git-pack",
          "content-length": "8",
          "x-hns-machine": "m1",
          "x-hns-body-hash": "00",
        },
        body: new Uint8Array(bytes),
      }),
    );
    const response = await face({
      ...request,
      env: envWith({ workspace: forward.namespace, db: d1.db }),
    });
    expect(response.status).toBe(200);
    const forwarded = forward.requests[0];
    expect(forwarded?.url).toBe("https://workspace.internal/rpc/checkpoint/run-1/pack");
    expect(forwarded?.headers.get("x-hns-machine")).toBe("m1");
    expect(forwarded?.headers.get("x-hns-body-hash")).toBe("00");
    expect(new Uint8Array(await (forwarded?.arrayBuffer() ?? new ArrayBuffer(0)))).toStrictEqual(
      bytes,
    );
  } finally {
    d1.close();
  }
});

// Catches: a pack over the limit being read before it is refused, and a pack offered without a
// declared length being forwarded on anyway.
test("a pack over the limit or without a length is refused before it is read", async () => {
  const forward = workspaceWith(() => new Response("{}", { status: 200 }));
  const d1 = await d1WithProject();
  try {
    const face = createCheckpointFace();
    const over = await checkpointRequest(
      new Request(BASE + "/api/workspaces/w1/checkpoints/run-1/pack", {
        method: "POST",
        headers: {
          "content-type": "application/x-git-pack",
          "content-length": String(64 * 1024 * 1024 + 1),
        },
      }),
    );
    expect(
      (await face({ ...over, env: envWith({ workspace: forward.namespace, db: d1.db }) })).status,
    ).toBe(413);
    // A body with no declared length is refused before it is read. The edge's JSON body reader
    // refuses a non-pack media type (the workerd suite covers that wire), so the length decides.
    const noLength = await checkpointRequest(
      new Request(BASE + "/api/workspaces/w1/checkpoints/run-1/pack", {
        method: "POST",
        headers: { "content-type": "application/x-git-pack" },
      }),
    );
    expect(
      (await face({ ...noLength, env: envWith({ workspace: forward.namespace, db: d1.db }) }))
        .status,
    ).toBe(400);
    expect(forward.requests).toStrictEqual([]);
  } finally {
    d1.close();
  }
});

// Catches: a workspace id that names no project reaching the object (which would create it).
test("an unknown workspace is a 404 and the object is not reached", async () => {
  const forward = workspaceWith(() => new Response("{}", { status: 200 }));
  const d1 = await d1WithProject();
  try {
    const face = createCheckpointFace();
    const request = await checkpointRequest(
      post("/api/workspaces/nope/checkpoints/prepare", '{"runId":"run-1"}'),
      "nope",
    );
    const response = await face({
      ...request,
      env: envWith({ workspace: forward.namespace, db: d1.db }),
    });
    expect(response.status).toBe(404);
    expect(forward.requests).toStrictEqual([]);
  } finally {
    d1.close();
  }
});
