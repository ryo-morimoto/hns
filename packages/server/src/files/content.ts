import { LEASE_REFUSALS, OperationIdSchema } from "@hns/core";
import * as v from "valibot";
import type { DurableObjectStub } from "../edge/env.ts";
import type { FilesRequest } from "../edge/handler.ts";
import { problem } from "../edge/problem.ts";

/**
 * The closed failure codes the files face answers with.
 *
 * @remarks
 * A caller branches on `code`. `conflict` means the file changed since the version the caller
 * sent; `unknown` means the save may or may not have landed and must be reconciled by a read;
 * `denied` is a refusal the machine decided before writing. None of these is ever rounded into
 * `applied`.
 */
export const FILES_FAILURES = [
  "invalid_request",
  "unsupported_media_type",
  "not_found",
  "conflict",
  "lease",
  "denied",
  "unknown",
  "unavailable",
  "internal",
] as const;

/** One failure code of the files face. */
export type FilesFailure = (typeof FILES_FAILURES)[number];

/** The body of a versioned write. */
const WriteInput = v.object({
  /** The project directory below the machine's ROOT; `""` is the root itself. */
  projectRoot: v.string(),
  path: v.pipe(v.string(), v.minLength(1)),
  /** The version the editor saw, or `"absent"`. */
  expectedVersion: v.pipe(v.string(), v.minLength(1)),
  /** The attempt's id; a retry with the same id returns the recorded outcome. */
  operationId: OperationIdSchema,
  /** The file's new text. */
  content: v.string(),
});

/** The query of a read. */
const ReadQuery = v.object({
  projectRoot: v.optional(v.string(), ""),
  path: v.pipe(v.string(), v.minLength(1)),
});

/** A flat JSON answer body; every field of this face's envelope is text or boolean. */
type FilesBody = { readonly [key: string]: string | boolean };

/** A JSON answer with no caching. */
function json(body: FilesBody, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** A failure of this face. */
function fail(code: FilesFailure, message: string, status: number): Response {
  return json({ ok: false, code, message }, status);
}

/** The DO RPC answer envelope. */
const RpcAnswer = v.variant("ok", [
  v.object({ ok: v.literal(true), result: v.unknown() }),
  v.object({ ok: v.literal(false), code: v.string(), message: v.pipe(v.string(), v.minLength(1)) }),
]);

/** The mutation result inside a successful apply. */
const RpcResult = v.variant("status", [
  v.object({ status: v.literal("applied"), operationId: v.string(), version: v.string() }),
  v.object({ status: v.literal("conflict"), operationId: v.string(), currentVersion: v.string() }),
  v.object({
    status: v.literal("unknown"),
    operationId: v.string(),
    reason: v.picklist(["io", "crash", "timeout"]),
  }),
]);

/** What a successful read RPC carries. */
const RpcRead = v.object({
  ok: v.literal(true),
  path: v.string(),
  version: v.string(),
  content: v.string(),
  externalChange: v.boolean(),
});

/** The workspace binding for one request, or a 503. */
function workspaceStub(
  env: FilesRequest["env"],
  workspaceId: string,
): DurableObjectStub | undefined {
  const namespace = env.WORKSPACE;
  if (namespace === undefined) return undefined;
  return namespace.get(namespace.idFromName(workspaceId));
}

/** Encode text for the internal RPC, which carries bytes as base64. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decode the internal RPC's base64, or undefined when the bytes are not UTF-8 text. */
function fromBase64(text: string): string | undefined {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Read one RPC answer, or report that it could not be parsed.
 *
 * @internal
 */
async function answerOf(response: Response): Promise<v.InferOutput<typeof RpcAnswer> | undefined> {
  try {
    return v.parse(RpcAnswer, await response.json());
  } catch {
    return undefined;
  }
}

/**
 * The files content face: versioned reads and writes over the machine.
 *
 * @param request - An authenticated edge request whose path names one workspace.
 * @returns The face's closed answer: 200 / 400 / 404 / 409 / 413 / 415 / 503 / 504.
 *
 * @remarks
 * The face owns the wire: it parses the caller's body, forwards a base64 body to the Workspace
 * object (which appends the intent, applies it on the machine, and settles the outcome), and
 * maps the recorded outcome to HTTP. A conflict is 409, an unknown is 504, and neither is ever
 * reported as a save. Authentication and the method are the edge's job (D059).
 */
export function createFilesFace(): (request: FilesRequest) => Promise<Response> {
  return async function files(request: FilesRequest): Promise<Response> {
    const stub = workspaceStub(request.env, request.workspaceId);
    if (stub === undefined) {
      return problem("unavailable", "The workspace binding is not configured.", "/api/workspaces");
    }
    const url = new URL(request.request.url);
    const headers = new Headers({ "content-type": "application/json" });
    headers.set("x-request-id", request.requestId);
    if (request.request.method === "POST") {
      const body = await request.request.text();
      const parsed = v.safeParse(WriteInput, JSON.parse(body.length === 0 ? "null" : body));
      if (!parsed.success) {
        return fail("invalid_request", "The write body is not valid.", 400);
      }
      const input = parsed.output;
      const forwarded = new Request("https://workspace.internal/rpc/apply", {
        method: "POST",
        headers,
        signal: request.signal,
        body: JSON.stringify({
          workspaceId: request.workspaceId,
          operationId: input.operationId,
          projectRoot: input.projectRoot,
          path: input.path,
          expectedVersion: input.expectedVersion,
          content: toBase64(input.content),
        }),
      });
      const answer = await stub.fetch(forwarded);
      const envelope = await answerOf(answer);
      if (envelope === undefined) {
        return fail("unavailable", "The workspace did not answer.", 503);
      }
      if (!envelope.ok) {
        const leaseRefusal = LEASE_REFUSALS.find((code) => code === envelope.code);
        if (leaseRefusal !== undefined) {
          // The workspace is not writable right now; this is not a version conflict.
          return json({ ok: false, code: "lease", reason: leaseRefusal }, 409);
        }
        switch (envelope.code) {
          case "denied":
            return fail("denied", envelope.message, 400);
          case "invalid_request":
            return fail("invalid_request", envelope.message, 400);
          case "not_found":
            return fail("not_found", envelope.message, 404);
          case "conflict":
            return fail("conflict", envelope.message, 409);
          case "unavailable":
            return fail("unavailable", envelope.message, 503);
          case "internal":
            return fail("internal", envelope.message, 500);
        }
        return fail("internal", "Unexpected workspace failure.", 500);
      }
      const result = v.safeParse(RpcResult, envelope.result);
      if (!result.success) return fail("internal", "The workspace result is not valid.", 500);
      const value = result.output;
      switch (value.status) {
        case "applied":
          return json(
            {
              ok: true,
              status: "applied",
              operationId: value.operationId,
              path: input.path,
              version: value.version,
            },
            200,
          );
        case "conflict":
          return json(
            {
              ok: false,
              code: "conflict",
              operationId: value.operationId,
              path: input.path,
              currentVersion: value.currentVersion,
            },
            409,
          );
        case "unknown":
          return json(
            {
              ok: false,
              code: "unknown",
              operationId: value.operationId,
              path: input.path,
              reason: value.reason,
            },
            504,
          );
      }
    }

    const query = v.safeParse(ReadQuery, {
      projectRoot: url.searchParams.get("projectRoot") ?? undefined,
      path: url.searchParams.get("path") ?? undefined,
    });
    if (!query.success) return fail("invalid_request", "The read query is not valid.", 400);
    const parameters = new URLSearchParams({
      projectRoot: query.output.projectRoot,
      path: query.output.path,
    });
    const forwarded = new Request("https://workspace.internal/rpc/read?" + parameters.toString(), {
      method: "GET",
      headers,
      signal: request.signal,
    });
    const answer = await stub.fetch(forwarded);
    if (answer.status === 404) return fail("not_found", "The file does not exist.", 404);
    const parsed = v.safeParse(RpcRead, await answer.json().catch(() => null));
    if (!parsed.success) {
      return fail(
        "unavailable",
        answer.ok ? "The read answer is not valid." : "The machine did not answer.",
        503,
      );
    }
    const text = fromBase64(parsed.output.content);
    if (text === undefined) {
      return fail("unsupported_media_type", "The file is not UTF-8 text.", 415);
    }
    return json({
      ok: true,
      path: parsed.output.path,
      version: parsed.output.version,
      content: text,
      externalChange: parsed.output.externalChange,
    });
  };
}
