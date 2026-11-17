import { LEASE_REFUSALS, OperationIdSchema, ProjectIdSchema } from "@hns/core";
import * as v from "valibot";
import { readBody } from "../edge/body.ts";
import type { DurableObjectStub, WorkerEnv } from "../edge/env.ts";
import type { FilesRequest } from "../edge/handler.ts";
import type { EdgeLimits } from "../edge/limits.ts";
import { projectFor } from "../edge/store.ts";
import { ProjectParamSchema } from "../project-id.ts";

/**
 * The closed failure codes the files face answers with.
 *
 * @remarks
 * A caller branches on `code`. `conflict` means the file changed since the version the caller
 * sent; `unknown` means the save may or may not have landed and must be reconciled by a read;
 * `denied` is a refusal the machine decided before writing. None of these is ever rounded into
 * `applied`.
 */
const FILES_FAILURES = [
  "invalid_request",
  "unsupported_media_type",
  "payload_too_large",
  "not_found",
  "conflict",
  "lease",
  "denied",
  "unknown",
  "unavailable",
  "internal",
] as const;

/** One failure code of the files face. */
type FilesFailure = (typeof FILES_FAILURES)[number];

/**
 * The body of a versioned write.
 *
 * @remarks
 * Strict: the project root is not the caller's to choose. It comes from the project row the
 * URL's workspace id names, so a body that still carries `projectRoot` is refused rather than
 * silently ignored.
 */
const WriteInput = v.strictObject({
  path: v.pipe(v.string(), v.minLength(1)),
  /** The version the editor saw, or `"absent"`. */
  expectedVersion: v.pipe(v.string(), v.minLength(1)),
  /** The attempt's id; a retry with the same id returns the recorded outcome. */
  operationId: OperationIdSchema,
  /** The file's new text. */
  content: v.string(),
});

/** The query of a read; strict for the same reason as {@link WriteInput}. */
const ReadQuery = v.strictObject({
  path: v.pipe(v.string(), v.minLength(1)),
});

/** The project root the Worker resolves for one project id. */
type ProjectRootLookup = (env: WorkerEnv, projectId: string) => Promise<string | undefined>;

/** The production lookup: the project's stored root. A missing project is undefined. */
async function projectRootFromStore(
  env: WorkerEnv,
  projectId: string,
): Promise<string | undefined> {
  const project = await projectFor(env, v.parse(ProjectIdSchema, projectId));
  return project?.workspace_root;
}

/** What the files face needs; tests replace the project lookup. */
export interface FilesFaceOptions {
  /** How the project's root is found; production reads D1. */
  readonly projectRoot?: ProjectRootLookup | undefined;
}

/** The root for this request, or the refusal to answer with. */
type ResolvedRoot =
  | { readonly ok: true; readonly root: string }
  | {
      readonly ok: false;
      readonly code: FilesFailure;
      readonly message: string;
      readonly status: number;
    };

/**
 * Find the root of the project the request names.
 *
 * @internal
 * @remarks
 * The workspace id is the project id (D080 F2). A malformed id is a 400, an absent project a
 * 404, and a store that cannot be read a 503: an outage must not read as "no such project".
 * Nothing is forwarded to the Workspace object before this resolves.
 */
async function resolveRoot(
  lookup: ProjectRootLookup,
  request: FilesRequest,
): Promise<ResolvedRoot> {
  const parsed = v.safeParse(ProjectParamSchema, request.workspaceId);
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_request",
      message: "The workspace id is not valid.",
      status: 400,
    };
  }
  let root: string | undefined;
  try {
    root = await lookup(request.env, parsed.output);
  } catch (error) {
    console.error(
      "files: project read failed",
      request.requestId,
      error instanceof Error ? error.name : "unknown",
    );
    return {
      ok: false,
      code: "unavailable",
      message: "The project could not be read.",
      status: 503,
    };
  }
  if (root === undefined) {
    return { ok: false, code: "not_found", message: "No project has this id.", status: 404 };
  }
  return { ok: true, root };
}

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

/** A failure envelope from the Workspace object. */
const RpcFailure = v.object({
  ok: v.literal(false),
  code: v.string(),
  message: v.pipe(v.string(), v.minLength(1)),
});

/** The apply answer: a mutation result, or the workspace's typed failure. */
const ApplyAnswer = v.variant("ok", [
  v.object({ ok: v.literal(true), result: v.unknown() }),
  RpcFailure,
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

/** A successful read answer: the machine's bytes (base64) and their version. */
const RpcRead = v.object({
  ok: v.literal(true),
  path: v.string(),
  version: v.string(),
  content: v.string(),
  externalChange: v.boolean(),
});

/** The read answer: a result, or the workspace's typed failure. */
const ReadAnswer = v.variant("ok", [RpcRead, RpcFailure]);

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
 * Map one Workspace failure onto this face's closed union.
 *
 * @param code - The workspace RPC code (or a lease refusal).
 * @param message - The workspace's diagnostic message; never a secret.
 * @returns The face's failure with the matching status.
 *
 * @remarks
 * The mapping is explicit so a status is never inferred from an envelope this face did not
 * expect: an unknown code is an internal error, not a success and not a guessed status.
 *
 * @internal
 */
function workspaceFailure(code: string, message: string): Response {
  const leaseRefusal = LEASE_REFUSALS.find((refusal) => refusal === code);
  if (leaseRefusal !== undefined) {
    // The workspace is not writable right now; this is not a version conflict.
    return json({ ok: false, code: "lease", reason: leaseRefusal }, 409);
  }
  switch (code) {
    case "invalid_request":
      return fail("invalid_request", message, 400);
    case "not_found":
      return fail("not_found", message, 404);
    case "conflict":
      return fail("conflict", message, 409);
    case "denied":
      return fail("denied", message, 400);
    case "payload_too_large":
      return fail("payload_too_large", message, 413);
    case "unavailable":
      return fail("unavailable", message, 503);
    case "internal":
      return fail("internal", message, 500);
  }
  return fail("internal", "Unexpected workspace failure.", 500);
}

/**
 * Read one JSON answer with its envelope, or undefined when it is not one.
 *
 * @internal
 */
async function bodyOf<T>(
  response: Response,
  schema: v.GenericSchema<unknown, T>,
): Promise<T | undefined> {
  try {
    return v.parse(schema, await response.json());
  } catch {
    return undefined;
  }
}

/**
 * The files content face: versioned reads and writes over the machine.
 *
 * @returns A handler for one authenticated edge request whose path names one workspace.
 * It receives the edge's request budgets, so the body limit this face enforces is the same one
 * the edge would enforce for any other face.
 *
 * @remarks
 * The face owns the wire: it reads the caller's body with the edge's limits, parses it, forwards
 * a base64 body to the Workspace object (which appends the intent, applies it on the machine, and
 * settles the outcome), and maps the recorded outcome to HTTP. The project root is resolved here
 * from the URL's workspace id (the project id): the caller never names a directory. A conflict is
 * 409, an unknown is 504, and neither is ever reported as a save. Authentication and the method
 * are the edge's job (D059); an oversized or non-JSON body is this face's failure (413 / 415).
 */
export function createFilesFace(
  options: FilesFaceOptions = {},
): (request: FilesRequest, limits: EdgeLimits) => Promise<Response> {
  const lookup = options.projectRoot ?? projectRootFromStore;
  return async function files(request: FilesRequest, limits: EdgeLimits): Promise<Response> {
    const resolved = await resolveRoot(lookup, request);
    if (!resolved.ok) return fail(resolved.code, resolved.message, resolved.status);
    const root = resolved.root;
    const stub = workspaceStub(request.env, request.workspaceId);
    if (stub === undefined) {
      // This face's failures are its own union, not the edge's problem+json (that is for
      // authentication and the method, which the edge answers before calling here).
      return fail("unavailable", "The workspace binding is not configured.", 503);
    }
    const url = new URL(request.request.url);
    const headers = new Headers({ "content-type": "application/json" });
    headers.set("x-request-id", request.requestId);

    if (request.request.method === "POST") {
      const body = await readBody(request.request, limits.maxBodyBytes);
      if (!body.ok) {
        return body.code === "payload_too_large"
          ? fail("payload_too_large", "The request body exceeds the configured limit.", 413)
          : fail("unsupported_media_type", "The request body must be application/json.", 415);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(body.text.length === 0 ? "null" : body.text);
      } catch {
        return fail("invalid_request", "The write body is not JSON.", 400);
      }
      const parsed = v.safeParse(WriteInput, raw);
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
          projectRoot: root,
          path: input.path,
          expectedVersion: input.expectedVersion,
          content: toBase64(input.content),
        }),
      });
      const answer = await stub.fetch(forwarded);
      const envelope = await bodyOf(answer, ApplyAnswer);
      if (envelope === undefined) {
        return fail("internal", "The workspace did not answer.", 500);
      }
      if (!envelope.ok) return workspaceFailure(envelope.code, envelope.message);
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
      path: url.searchParams.get("path") ?? undefined,
    });
    if (!query.success) return fail("invalid_request", "The read query is not valid.", 400);
    if (url.searchParams.has("projectRoot")) {
      return fail("invalid_request", "The project root is not a request parameter.", 400);
    }
    const parameters = new URLSearchParams({
      projectRoot: root,
      path: query.output.path,
    });
    const forwarded = new Request("https://workspace.internal/rpc/read?" + parameters.toString(), {
      method: "GET",
      headers,
      signal: request.signal,
    });
    const answer = await stub.fetch(forwarded);
    const envelope = await bodyOf(answer, ReadAnswer);
    if (envelope === undefined) {
      return fail("internal", "The workspace did not answer.", 500);
    }
    if (!envelope.ok) return workspaceFailure(envelope.code, envelope.message);
    const text = fromBase64(envelope.content);
    if (text === undefined) {
      return fail("unsupported_media_type", "The file is not UTF-8 text.", 415);
    }
    return json({
      ok: true,
      path: envelope.path,
      version: envelope.version,
      content: text,
      externalChange: envelope.externalChange,
    });
  };
}
