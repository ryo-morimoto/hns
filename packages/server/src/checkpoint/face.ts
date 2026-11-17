import { ProjectIdSchema } from "@hns/core";
import * as v from "valibot";
import { readBody } from "../edge/body.ts";
import type { DurableObjectStub, WorkerEnv } from "../edge/env.ts";
import type { CheckpointRequest } from "../edge/handler.ts";
import { problem } from "../edge/problem.ts";
import { projectFor, StoreUnavailableError } from "../edge/store.ts";
import { ProjectParamSchema } from "../project-id.ts";

/**
 * The checkpoint face: one Run's checkpoint, from the Worker's side.
 *
 * @remarks
 * The machine reaches the Worker through the tunnel; the checkpoint is the Workspace object's,
 * so this face authenticates, checks what it can before reading a body, and forwards. It never
 * decides a checkpoint's meaning: the object verifies the pack's signature and hash, keys the
 * pack by the prepare answer, and writes the record.
 *
 * - `POST /api/workspaces/<workspaceId>/checkpoints/prepare` — the machine's checkpoint,
 *   metadata only.
 * - `POST /api/workspaces/<workspaceId>/checkpoints/<runId>/pack` — the machine's signed pack:
 *   `application/x-git-pack`, a declared length, and no more than 64 MiB, refused before the
 *   body is read. The bytes and the signed headers are forwarded unchanged, so the object's
 *   checks are made against exactly what arrived.
 * - `POST /api/workspaces/<workspaceId>/checkpoints/complete` — the watermark and the record.
 *
 * A successful answer is the object's envelope unchanged (`ok: true` and its result), and a
 * refusal keeps the object's status and code: the face does not re-spell either.
 */

/** The body of a prepare or complete request. */
const CheckpointBody = v.object({
  runId: v.pipe(v.string(), v.minLength(1)),
  throughSeq: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

/** The Workspace object's stub for one workspace, or undefined without the binding. */
function workspaceStub(env: WorkerEnv, workspaceId: string): DurableObjectStub | undefined {
  const namespace = env.WORKSPACE;
  if (namespace === undefined) return undefined;
  return namespace.get(namespace.idFromName(workspaceId));
}

/**
 * Create the checkpoint face.
 *
 * @returns A handler for one authenticated edge request whose path names one workspace.
 *
 * @remarks
 * The workspace id is the project id (D080). A missing project is a 404 and an unreadable store a
 * 503, both before the object is reached; a missing binding is a 503. Authentication and the
 * method belong to the edge, which answers them before this handler (D059).
 */
export function createCheckpointFace(): (request: CheckpointRequest) => Promise<Response> {
  return async function checkpoint(request) {
    const url = new URL(request.request.url);
    const segments = url.pathname.split("/").filter((segment) => segment !== "");
    // /api/workspaces/<workspaceId>/checkpoints/<action>
    const action = segments[4];
    const stub = workspaceStub(request.env, request.workspaceId);
    if (stub === undefined) {
      return problem("unavailable", "The workspace binding is not configured.", url.pathname);
    }
    try {
      await assertProjectExists(request.env, request.workspaceId);
    } catch (error) {
      if (error instanceof NoSuchProjectError) {
        return problem("not_found", "No project has this id.", url.pathname);
      }
      if (error instanceof StoreUnavailableError) {
        return problem("unavailable", "The project could not be read.", url.pathname);
      }
      throw error;
    }

    if (segments.length === 5 && (action === "prepare" || action === "complete")) {
      return await forwardCheckpoint(request, stub, action);
    }
    const runId = segments[4];
    if (segments.length === 6 && runId !== undefined && segments[5] === "pack") {
      return await forwardPack(request, stub, runId);
    }
    return problem("not_found", "No route matches this path.", url.pathname);
  };
}

/** A workspace id that is malformed or names no project. */
class NoSuchProjectError extends Error {
  constructor() {
    super("no project has this id");
    this.name = "NoSuchProjectError";
  }
}

/**
 * Check that the workspace id names a project, before the object is reached.
 *
 * @param env - The Worker environment, for D1.
 * @param workspaceId - The id the path names.
 * @throws {NoSuchProjectError} when the id is malformed or names no project.
 * @throws {StoreUnavailableError} when D1 cannot be read.
 */
async function assertProjectExists(env: WorkerEnv, workspaceId: string): Promise<void> {
  const id = v.safeParse(ProjectParamSchema, workspaceId);
  if (!id.success) throw new NoSuchProjectError();
  if ((await projectFor(env, v.parse(ProjectIdSchema, id.output))) === undefined) {
    throw new NoSuchProjectError();
  }
}

/** Forward a prepare or complete, which are JSON. */
async function forwardCheckpoint(
  request: CheckpointRequest,
  stub: DurableObjectStub,
  action: "prepare" | "complete",
): Promise<Response> {
  const path = new URL(request.request.url).pathname;
  const body = await readBody(request.request, request.limits.maxBodyBytes);
  if (!body.ok) {
    return problem(
      body.code,
      body.code === "payload_too_large"
        ? "The request body exceeds the configured limit."
        : "The request body must be application/json.",
      path,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body.text.length === 0 ? "null" : body.text);
  } catch {
    return problem("invalid_request", "The checkpoint body is not JSON.", path);
  }
  const parsed = v.safeParse(CheckpointBody, raw);
  if (!parsed.success) {
    return problem("invalid_request", "The checkpoint body is not valid.", path);
  }
  const input = parsed.output;
  const forwardedBody =
    input.throughSeq === undefined
      ? { workspaceId: request.workspaceId, runId: input.runId }
      : { workspaceId: request.workspaceId, runId: input.runId, throughSeq: input.throughSeq };
  const forwarded = new Request("https://workspace.internal/rpc/checkpoint/" + action, {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": request.requestId },
    signal: request.signal,
    body: JSON.stringify(forwardedBody),
  });
  return await passThrough(stub.fetch(forwarded));
}

/** Forward the machine's signed pack without touching its bytes or its signed headers. */
async function forwardPack(
  request: CheckpointRequest,
  stub: DurableObjectStub,
  runId: string,
): Promise<Response> {
  const path = new URL(request.request.url).pathname;
  // The media type was decided before the body was read: the edge's JSON body reader refuses
  // anything that is not `application/json` with the same 415, so a pack path cannot reach here
  // with another type. The declared length is re-checked against the pack limit here.
  const declared = request.request.headers.get("content-length");
  if (declared === null || !/^[0-9]{1,15}$/u.test(declared)) {
    return problem("invalid_request", "A pack upload must declare a content-length.", path);
  }
  if (Number(declared) > request.limits.maxPackBytes) {
    // Refused before the body is read: a pack over the limit is never kept, even partly.
    return problem("payload_too_large", "The pack is larger than the checkpoint limit.", path);
  }
  const bytes = await readPackBytes(request.request, request.limits.maxPackBytes);
  if (bytes === undefined) {
    return problem("invalid_request", "The pack body could not be read.", path);
  }
  // A plain ArrayBuffer-backed view: the body must be a body a Request accepts.
  const headers = new Headers(request.request.headers);
  headers.set("x-request-id", request.requestId);
  const forwarded = new Request("https://workspace.internal/rpc/checkpoint/" + runId + "/pack", {
    method: "POST",
    headers,
    signal: request.signal,
    body: new Uint8Array(bytes),
  });
  return await passThrough(stub.fetch(forwarded));
}

/** Read the pack body as bytes, up to the limit; undefined when it passes it or breaks. */
async function readPackBytes(request: Request, maxBytes: number): Promise<Uint8Array | undefined> {
  const stream = request.body;
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Pass the workspace's answer through: its status, its code, and no caching. */
async function passThrough(pending: Promise<Response>): Promise<Response> {
  const answer = await pending;
  return new Response(await answer.arrayBuffer(), {
    status: answer.status,
    headers: {
      "content-type": answer.headers.get("content-type") ?? "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
