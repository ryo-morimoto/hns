import * as v from "valibot";
import type { Project } from "@hns/core";
import { OFFICE_ERROR_CODES, PREVIEW_STATUSES } from "@hns/core/office";
import type { OfficePort } from "./office.ts";
import type { DocumentPreviewView, OfficeEngineView, OfficeFailureView } from "../do/office-job.ts";
import { VERSION_UNREADABLE, workspaceVersionOver } from "./office-version.ts";
import { officeObjectName, officeWorkspaceOf } from "../office/route.ts";
import { SESSION_NAME_HEADER } from "../edge/env.ts";
import { officeFailureOf } from "../do/office-job.ts";
/** What the office port needs: the environment, the request's signal, and the workspace lookup. */
export interface OfficePortOptions {
  readonly env: import("../edge/env.ts").WorkerEnv;
  readonly requestId: string;
  readonly signal: AbortSignal;
  /** Finds the workspace row for an id, through the same store read the rest of the face uses. */
  readonly project: (workspaceId: string) => Promise<Project | undefined>;
  /** How the workspace's Session object is reached; production reads the `SESSION` binding. */
  readonly session?:
    | ((workspaceId: string) => Promise<{ fetch(request: Request): Promise<Response> }>)
    | undefined;
}

/** The row a DocumentPreview member carries, as the Session object answers it. */
const DocumentPreviewBody = v.object({
  __typename: v.literal("DocumentPreview"),
  path: v.string(),
  version: v.string(),
  status: v.string(),
  url: v.nullable(v.string()),
  pages: v.nullable(v.number()),
  bytes: v.nullable(v.number()),
  missingFonts: v.array(v.string()),
  engine: v.nullable(v.string()),
  generatedAt: v.nullable(v.string()),
  error: v.nullable(v.object({ code: v.string(), message: v.string() })),
});

/** What the object answers for a preview read or request. */
const PreviewAnswer = v.union([
  DocumentPreviewBody,
  v.object({ __typename: v.literal("OfficeFailure"), code: v.string(), message: v.string() }),
]);

/** What the object answers for the engine probe. */
const EngineAnswer = v.union([
  v.object({ __typename: v.literal("OfficeEngineAvailable"), id: v.string(), version: v.string() }),
  v.object({ __typename: v.literal("OfficeEngineUnavailable"), reason: v.string() }),
  v.object({ __typename: v.literal("OfficeFailure"), code: v.string(), message: v.string() }),
]);

/**
 * Build the office port over one request's Worker environment (0237).
 *
 * @param options - The environment, the request's id and signal, and the workspace lookup.
 * @returns The port: a preview read, a preview request, and the engine probe.
 *
 * @remarks
 * **The workspace is checked here, before the object is addressed.** The machine is one workspace
 * and a Session object is one project (D080), so the object's name is the project id; a request
 * for another project's preview would be a request to that project's object, which this port
 * must not make on a caller's say-so. The row the object keeps carries the workspace in its key,
 * so the object checks it again.
 *
 * **The route is the object's, not the row's.** Every call goes to
 * `/rpc/office/(preview|request|engine)` on the object the workspace names; a missing binding or
 * a missing workspace is the failure union's `engine_unavailable`, never a crash.
 */
export async function officePortOver(options: OfficePortOptions): Promise<OfficePort> {
  /** Address the Session object for one workspace, after checking the workspace exists. */
  async function stubFor(
    workspaceId: string,
  ): Promise<import("../edge/env.ts").DurableObjectStub | undefined> {
    let workspace: Project | undefined;
    try {
      workspace = await options.project(workspaceId);
    } catch (error) {
      // A lookup that threw is the same answer as one that found nothing (fail closed); the log
      // line names the error's class only, so an operator can tell a defect from a missing row.
      console.error(
        "office: project lookup failed",
        error instanceof Error ? error.name + ": " + error.message.slice(0, 200) : "unknown",
      );
      return undefined;
    }
    if (workspace === undefined) return undefined;
    if (options.session !== undefined) return await options.session(workspaceId);
    const session = options.env.SESSION;
    if (session === undefined) return undefined;
    // The object this resolves to is the one the preview URL names: both read the name from
    // `officeObjectName`, so a row's url and the route that serves it address one object (B2).
    return session.get(session.idFromName(officeObjectName(workspaceId)));
  }

  /**
   * One call to the object's office route, parsed at the boundary.
   *
   * @param stub - The Session object the workspace resolves to.
   * @param name - That object's name, which the request is addressed with.
   * @param path - The object's office route, query included.
   * @param schema - The schema the answer is parsed with.
   * @param init - The method and, for a request, the body.
   * @returns The parsed answer, or undefined when the object did not answer one.
   */
  async function ask<T>(
    stub: import("../edge/env.ts").DurableObjectStub,
    name: string,
    path: string,
    schema: v.GenericSchema<unknown, T>,
    init: { readonly method: "GET" | "POST"; readonly body?: unknown },
  ): Promise<T | undefined> {
    let response: Response;
    try {
      response = await stub.fetch(
        new Request("https://session.internal" + path, {
          method: init.method,
          headers: {
            "content-type": "application/json",
            "x-request-id": options.requestId,
            // The object checks this against its own name and against the workspace the query
            // names: a request must be addressed to it, not only say which workspace it wants.
            [SESSION_NAME_HEADER]: name,
          },
          body: init.body === undefined ? null : JSON.stringify(init.body),
          signal: options.signal,
        }),
      );
    } catch {
      return undefined;
    }
    if (!response.ok) return undefined;
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return undefined;
    }
    const parsed = v.safeParse(schema, raw);
    return parsed.success ? parsed.output : undefined;
  }

  return {
    async preview(workspaceId, path, workspaceVersion) {
      const stub = await stubFor(workspaceId);
      if (stub === undefined) return undefined;
      const query = new URLSearchParams({
        workspaceId: officeWorkspaceOf(workspaceId),
        path,
      });
      if (workspaceVersion !== undefined) query.set("v", workspaceVersion);
      const answer = await ask(
        stub,
        officeObjectName(officeWorkspaceOf(workspaceId)),
        "/rpc/office/preview?" + query.toString(),
        PreviewAnswer,
        { method: "GET" },
      );
      return answer === undefined ? undefined : previewOf(answer);
    },
    async request(workspaceId, path, workspaceVersion) {
      const stub = await stubFor(workspaceId);
      if (stub === undefined) {
        return officeFailureOf("engine_unavailable", "This project has no session to ask.");
      }
      const answer = await ask(
        stub,
        officeObjectName(officeWorkspaceOf(workspaceId)),
        "/rpc/office/request?" +
          new URLSearchParams({ workspaceId: officeWorkspaceOf(workspaceId) }).toString(),
        PreviewAnswer,
        { method: "POST", body: { path, version: workspaceVersion } },
      );
      if (answer === undefined) {
        return officeFailureOf("engine_unavailable", "The session did not answer.");
      }
      return previewOf(answer);
    },
    async engine(workspaceId) {
      const stub = await stubFor(workspaceId);
      if (stub === undefined) {
        return {
          __typename: "OfficeEngineUnavailable",
          reason: "This project has no session to ask.",
        };
      }
      const answer = await ask(
        stub,
        officeObjectName(officeWorkspaceOf(workspaceId)),
        "/rpc/office/engine?" +
          new URLSearchParams({ workspaceId: officeWorkspaceOf(workspaceId) }).toString(),
        EngineAnswer,
        { method: "GET" },
      );
      if (answer === undefined) {
        return officeFailureOf("engine_unavailable", "The session did not answer.");
      }
      return engineOf(answer);
    },
    workspaceVersion: await workspaceVersionOver(options),
  };
}

/**
 * The office port a context built without one gets: every call is the failure union's
 * `engine_unavailable`.
 *
 * @remarks
 * A deployment without the office face, and a resolver test that does not ask about previews,
 * both get this. It never reaches an object, so a context that was not given a port cannot
 * accidentally address one.
 */
/**
 * One preview answer, read as the office unions.
 *
 * @param answer - The parsed answer: a row, or the failure union's member.
 * @returns The same value, typed as the port's answer.
 *
 * @remarks
 * The schema parsed what the object sent, so this is a reading of the parsed value rather than a
 * cast: the union's `__typename` decides, and every field is the one its member carries.
 */
function previewOf(
  answer: v.InferOutput<typeof PreviewAnswer>,
): DocumentPreviewView | OfficeFailureView {
  if (answer.__typename === "OfficeFailure") {
    return officeFailureOf(v.parse(v.picklist(OFFICE_ERROR_CODES), answer.code), answer.message);
  }
  return {
    __typename: "DocumentPreview",
    path: answer.path,
    version: answer.version,
    status: v.parse(v.picklist(PREVIEW_STATUSES), answer.status),
    url: answer.url,
    pages: answer.pages,
    bytes: answer.bytes,
    missingFonts: answer.missingFonts,
    engine: answer.engine,
    generatedAt: answer.generatedAt,
    error:
      answer.error === null
        ? null
        : officeFailureOf(
            v.parse(v.picklist(OFFICE_ERROR_CODES), answer.error.code),
            answer.error.message,
          ),
  };
}

/**
 * One engine answer, read as the office unions.
 *
 * @param answer - The parsed answer: the engine, why it is absent, or the failure member.
 * @returns The same value, typed as the engine union or the failure.
 */
function engineOf(
  answer: v.InferOutput<typeof EngineAnswer>,
): OfficeEngineView | OfficeFailureView {
  if (answer.__typename === "OfficeFailure") {
    return officeFailureOf(v.parse(v.picklist(OFFICE_ERROR_CODES), answer.code), answer.message);
  }
  return answer.__typename === "OfficeEngineAvailable"
    ? { __typename: "OfficeEngineAvailable", id: answer.id, version: answer.version }
    : { __typename: "OfficeEngineUnavailable", reason: answer.reason };
}

export const NO_OFFICE_PORT: OfficePort = {
  async preview() {
    return undefined;
  },
  async request() {
    return officeFailureOf("engine_unavailable", "This deployment has no office previews.");
  },
  async engine() {
    return officeFailureOf("engine_unavailable", "This deployment has no office previews.");
  },
  async workspaceVersion() {
    return VERSION_UNREADABLE;
  },
};
