import { expect, test } from "vitest";
import * as v from "valibot";
import { fakeMachine, versionOfText, type FakeMachine } from "../../test/support/machine.ts";
import { openSqliteState, type TestSqliteState } from "../../test/support/sqlite.ts";
import { Workspace } from "../do/workspace.ts";
import type { DurableObjectId, DurableObjectNamespace, DurableObjectStub } from "../edge/env.ts";
import type { FilesRequest } from "../edge/handler.ts";
import { DEFAULT_LIMITS } from "../edge/limits.ts";
import { createFilesFace } from "./content.ts";

interface Harness {
  readonly face: (request: FilesRequest) => Promise<Response>;
  readonly namespace: DurableObjectNamespace;
  readonly machine: FakeMachine;
  readonly state: TestSqliteState;
  close(): void;
}

/**
 * A files face over a real Workspace object and a fake machine.
 *
 * @remarks
 * The object, its SQLite, the journal, and the face are the production code; only the machine
 * is a fake. The stub forwards the face's Request straight to the object, as the Worker's
 * binding does.
 */
function harness(maxBodyBytes?: number): Harness {
  const opened = openSqliteState();
  const machine = fakeMachine();
  const workspace = new Workspace(opened.state, { files: machine });
  const stub: DurableObjectStub = { fetch: (request: Request) => workspace.fetch(request) };
  const namespace: DurableObjectNamespace = {
    idFromName(name: string): DurableObjectId {
      return { name };
    },
    get(): DurableObjectStub {
      return stub;
    },
  };
  const face =
    maxBodyBytes === undefined
      ? createFilesFace()
      : createFilesFace({ ...DEFAULT_LIMITS, maxBodyBytes });
  return {
    face,
    namespace,
    machine,
    state: opened.state,
    close: opened.close,
  };
}

interface RequestOptions {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  /** Raw text to send instead of a JSON body (for a malformed-body test). */
  readonly rawBody?: string;
  /** The content type to declare; defaults to JSON. */
  readonly contentType?: string;
  readonly query?: Record<string, string>;
  readonly workspaceId?: string;
}

/** Acquire the workspace's lease through the object, as the machine would. */
async function acquire(h: Harness): Promise<void> {
  const id = h.namespace.idFromName("w1");
  const response = await h.namespace.get(id).fetch(
    new Request("https://workspace.internal/rpc/lease/acquire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "w1", machineId: "m1" }),
    }),
  );
  expect(response.status).toBe(200);
}

interface WriteBody {
  readonly projectRoot: string;
  readonly path: string;
  readonly expectedVersion: string;
  readonly operationId: string;
  readonly content: string;
}

function writeBody(overrides: Partial<WriteBody> = {}): WriteBody {
  return {
    projectRoot: "project",
    path: "a.txt",
    expectedVersion: "absent",
    operationId: "op-1",
    content: "one",
    ...overrides,
  };
}

/** One authenticated files request, as the edge would hand it over. */
function requestFor(h: Harness, options: RequestOptions = {}): FilesRequest {
  const query = new URLSearchParams(options.query ?? {});
  const url =
    "https://hns.test/api/workspaces/" +
    (options.workspaceId ?? "w1") +
    "/files" +
    (options.query === undefined ? "" : "?" + query.toString());
  const init: RequestInit =
    options.method === "POST"
      ? {
          method: "POST",
          headers: {
            "content-type": options.contentType ?? "application/json",
            "x-request-id": "request-1",
          },
          body: options.rawBody ?? JSON.stringify(options.body),
        }
      : { headers: { "x-request-id": "request-1" } };
  return {
    request: new Request(url, init),
    env: { WORKSPACE: h.namespace },
    session: { subject: "owner", expiresAt: Date.now() + 60_000 },
    requestId: "request-1",
    signal: new AbortController().signal,
    workspaceId: options.workspaceId ?? "w1",
  };
}

const Applied = v.object({
  ok: v.literal(true),
  status: v.literal("applied"),
  operationId: v.string(),
  path: v.string(),
  version: v.string(),
});
const Conflict = v.object({
  ok: v.literal(false),
  code: v.literal("conflict"),
  operationId: v.string(),
  path: v.string(),
  currentVersion: v.string(),
});
const Unknown = v.object({ ok: v.literal(false), code: v.literal("unknown") });
const ReadOk = v.object({
  ok: v.literal(true),
  path: v.string(),
  version: v.string(),
  content: v.string(),
  externalChange: v.boolean(),
});

// Catches: a save that returns 200 before the machine applied it, or one that loses the
// operation id and the version in its answer.
test("a save is applied through the object and answered with its version", async () => {
  const h = harness();
  try {
    await acquire(h);
    const response = await h.face(requestFor(h, { method: "POST", body: writeBody() }));
    expect(response.status).toBe(200);
    expect(v.parse(Applied, await response.json())).toStrictEqual({
      ok: true,
      status: "applied",
      operationId: "op-1",
      path: "a.txt",
      version: versionOfText("one"),
    });
    expect(h.machine.contentOf("project/a.txt")).toBe("one");
  } finally {
    h.close();
  }
});

// Catches: a stale save reported as applied, or its conflict losing the winning version.
test("a stale save is a 409 conflict with the machine's current version", async () => {
  const h = harness();
  try {
    await acquire(h);
    await h.face(requestFor(h, { method: "POST", body: writeBody() }));
    const response = await h.face(
      requestFor(h, {
        method: "POST",
        body: writeBody({ operationId: "op-2", content: "two" }),
      }),
    );
    expect(response.status).toBe(409);
    expect(v.parse(Conflict, await response.json())).toStrictEqual({
      ok: false,
      code: "conflict",
      operationId: "op-2",
      path: "a.txt",
      currentVersion: versionOfText("one"),
    });
    expect(h.machine.contentOf("project/a.txt")).toBe("one");
  } finally {
    h.close();
  }
});

// Catches: a save whose machine never answered being reported as a success.
test("a save with no machine answer is a 504 unknown", async () => {
  const h = harness();
  try {
    await acquire(h);
    h.machine.failNext();
    const response = await h.face(requestFor(h, { method: "POST", body: writeBody() }));
    expect(response.status).toBe(504);
    expect(v.parse(Unknown, await response.json()).code).toBe("unknown");
  } finally {
    h.close();
  }
});

// Catches: a machine refusal turned into a version conflict, which would make the editor reload.
test("a refused save is a typed denial", async () => {
  const h = harness();
  try {
    await acquire(h);
    h.machine.denyNext("path_denied");
    const response = await h.face(requestFor(h, { method: "POST", body: writeBody() }));
    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({
      ok: false,
      code: "denied",
      message: "path_denied",
    });
  } finally {
    h.close();
  }
});

test("a save without a lease is a lease failure, not a conflict", async () => {
  const h = harness();
  try {
    const response = await h.face(requestFor(h, { method: "POST", body: writeBody() }));
    expect(response.status).toBe(409);
    expect(await response.json()).toStrictEqual({
      ok: false,
      code: "lease",
      reason: "lease_not_held",
    });
  } finally {
    h.close();
  }
});

test("a malformed save body is refused", async () => {
  const h = harness();
  try {
    await acquire(h);
    for (const body of [
      {},
      { ...writeBody(), operationId: "bad id" },
      { ...writeBody(), path: "" },
      { ...writeBody(), expectedVersion: "" },
    ]) {
      const response = await h.face(requestFor(h, { method: "POST", body }));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
    expect(h.machine.writes).toStrictEqual([]);
  } finally {
    h.close();
  }
});

// Catches: a read that returns a cached value, hides binary content, or misses an external change.
test("a read returns the text, its version, and an external change", async () => {
  const h = harness();
  try {
    await acquire(h);
    await h.face(requestFor(h, { method: "POST", body: writeBody() }));
    const first = await h.face(requestFor(h, { query: { projectRoot: "project", path: "a.txt" } }));
    expect(first.status).toBe(200);
    expect(v.parse(ReadOk, await first.json())).toStrictEqual({
      ok: true,
      path: "a.txt",
      version: versionOfText("one"),
      content: "one",
      externalChange: false,
    });
    h.machine.seed("project/a.txt", "changed");
    const second = v.parse(
      ReadOk,
      await (
        await h.face(requestFor(h, { query: { projectRoot: "project", path: "a.txt" } }))
      ).json(),
    );
    expect(second.version).toBe(versionOfText("changed"));
    expect(second.externalChange).toBe(true);
    h.machine.seedRaw("project/a.txt", Buffer.from([0xff, 0xfe]).toString("base64"));
    const binary = await h.face(
      requestFor(h, { query: { projectRoot: "project", path: "a.txt" } }),
    );
    expect(binary.status).toBe(415);
    expect(await binary.json()).toMatchObject({ code: "unsupported_media_type" });
  } finally {
    h.close();
  }
});

test("a read of a missing file is 404 and an offline machine is 503", async () => {
  const h = harness();
  try {
    // No lease has named a machine yet, so there is nowhere to read from.
    const unbound = await h.face(requestFor(h, { query: { path: "missing.txt" } }));
    expect(unbound.status).toBe(503);
    await acquire(h);
    const missing = await h.face(requestFor(h, { query: { path: "missing.txt" } }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "not_found" });
    h.machine.failNext();
    const offline = await h.face(requestFor(h, { query: { path: "a.txt" } }));
    expect(offline.status).toBe(503);
    expect(await offline.json()).toMatchObject({ code: "unavailable" });
  } finally {
    h.close();
  }
});
// Catches: a malformed or oversized save body reaching JSON.parse or the workspace.
test("a non-JSON, wrongly typed, or oversized body is refused at the face", async () => {
  const h = harness();
  try {
    await acquire(h);
    const notJson = await h.face(requestFor(h, { method: "POST", rawBody: "{not json" }));
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ code: "invalid_request" });

    const wrongType = await h.face(
      requestFor(h, { method: "POST", body: writeBody(), contentType: "text/plain" }),
    );
    expect(wrongType.status).toBe(415);
    expect(await wrongType.json()).toMatchObject({ code: "unsupported_media_type" });

    expect(h.machine.writes).toStrictEqual([]);
  } finally {
    h.close();
  }
  const small = harness(16);
  try {
    await acquire(small);
    const oversized = await small.face(requestFor(small, { method: "POST", body: writeBody() }));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "payload_too_large" });
    expect(small.machine.writes).toStrictEqual([]);
  } finally {
    small.close();
  }
});

// Catches: a workspace 400 (an unsafe path) being reported as "the machine is unavailable".
test("a read the workspace refuses keeps its status", async () => {
  const h = harness();
  try {
    await acquire(h);
    const response = await h.face(
      requestFor(h, { query: { projectRoot: "project", path: "../secret" } }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
  } finally {
    h.close();
  }
});

// Catches: a file beyond the machine's read bound reported as missing.
test("a read beyond the bound is a 413", async () => {
  const h = harness();
  try {
    await acquire(h);
    await h.face(requestFor(h, { method: "POST", body: writeBody() }));
    h.machine.tooLargeNext();
    const response = await h.face(
      requestFor(h, { query: { projectRoot: "project", path: "a.txt" } }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "payload_too_large" });
  } finally {
    h.close();
  }
});

// Catches: a workspace answer that is not its envelope being reported as a save or a read.
test("an answer that is not the workspace envelope is an internal error", async () => {
  const h = harness();
  try {
    const base = requestFor(h, { query: { path: "a.txt" } });
    const env = {
      WORKSPACE: {
        idFromName: (name: string) => ({ name }),
        get: () => ({ fetch: () => Promise.resolve(new Response("not json", { status: 200 })) }),
      },
    };
    const response = await h.face({ ...base, env });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "internal" });
  } finally {
    h.close();
  }
});

// Catches: a reused operation id reported as a version conflict.
test("a reused operation id is a denial, not a conflict", async () => {
  const h = harness();
  try {
    await acquire(h);
    await h.face(requestFor(h, { method: "POST", body: writeBody() }));
    const response = await h.face(
      requestFor(h, { method: "POST", body: writeBody({ content: "two" }) }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "denied" });
  } finally {
    h.close();
  }
});
