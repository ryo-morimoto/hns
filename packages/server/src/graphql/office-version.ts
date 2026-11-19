import * as v from "valibot";
import type { OfficePortOptions } from "./office-port.ts";
import type { OfficeFailureView } from "../do/office-job.ts";
import { officeFailureOf } from "../do/office-job.ts";
import { officeObjectName } from "../office/route.ts";

/** One file's current version, or the failure that says why it could not be read. */
export type WorkspaceVersion =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly failure: OfficeFailureView };

/**
 * Why a version could not be read.
 *
 * @remarks
 * **Not `source_changed`.** A file the Workspace route could not read (it answers text, bounded at
 * 256 KiB) has no version this face can name; saying the source changed would be a lie about
 * which bytes are there, and a person would reload a file that did not move. The code is
 * `engine_unavailable`: the office contract has no code for "the server could not read the file",
 * and this one says the request did not become a job (the same member a machine that cannot be
 * reached uses), which is what a screen must show as "could not check", not as "changed".
 */
export const VERSION_UNREADABLE: WorkspaceVersion = {
  ok: false,
  failure: officeFailureOf(
    "engine_unavailable",
    "The file's version could not be read, so no preview can be requested for it.",
  ),
};

/**
 * Read one file's version from the machine, through the Workspace object's own read route (0237).
 *
 * @param options - The environment, the request's id, and the project lookup.
 * @returns A reader of one (workspace, path) pair's current version, or the failure it could not
 * be read with.
 *
 * @remarks
 * The preview's job names the bytes it reads (INV-O2), so a request made without a version would
 * be a job the machine refuses `source_changed`. The Workspace object already answers "the bytes
 * and their version" for one path (`GET /rpc/read`), and it is the only place that binds the
 * project's root to the machine; this asks it rather than reading the machine from here, so a
 * path outside the project is refused by the object that owns the binding.
 */
export async function workspaceVersionOver(
  options: OfficePortOptions,
): Promise<(workspaceId: string, path: string) => Promise<WorkspaceVersion>> {
  return async (workspaceId, path) => {
    const project = await options.project(workspaceId).catch(() => undefined);
    if (project === undefined) return VERSION_UNREADABLE;
    const workspaces = options.env.WORKSPACE;
    if (workspaces === undefined) return VERSION_UNREADABLE;
    // The object's name is the project's id (D080), and the caller's workspace is the graph's:
    // one name for one object, read through the one function that decides it.
    const stub = workspaces.get(workspaces.idFromName(officeObjectName(workspaceId)));
    const query = new URLSearchParams({ projectRoot: project.workspace_root, path });
    let response: Response;
    try {
      response = await stub.fetch(
        new Request("https://workspace.internal/rpc/read?" + query.toString(), {
          method: "GET",
          headers: { "x-request-id": options.requestId },
          signal: options.signal,
        }),
      );
    } catch {
      return VERSION_UNREADABLE;
    }
    if (!response.ok) return VERSION_UNREADABLE;
    const answer = v.safeParse(
      v.object({ ok: v.literal(true), version: v.string() }),
      await response.json().catch(() => undefined),
    );
    return answer.success ? { ok: true, version: answer.output.version } : VERSION_UNREADABLE;
  };
}
