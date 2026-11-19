import { OFFICE_PREVIEW_PATH } from "@hns/core/office";
import { fromGlobalId } from "@hns/core/graphql";
import { sessionNameFor } from "../session-name.ts";

/**
 * The Session object name one workspace id addresses (0237).
 *
 * @param projectId - The project id, as a request names it.
 * @returns The object name: the project id, except that the legacy default project keeps the
 * name it had before projects had roots.
 * @throws Error when the id is empty, because an unnamed object would merge projects.
 *
 * @remarks
 * **One function decides the object name**, and one function decides which workspace the office
 * rows belong to. The GraphQL port (`officePortOver`), the preview route (`/api/office/preview`),
 * and the route the answer names (`previewUrl`) all read both through this module, so the url a
 * `ready` row hands out and the route that serves it address the same object (B2).
 *
 * The workspace the rows are keyed by is {@link officeWorkspaceOf}: for every project but the
 * legacy default it is the id itself; the default project's object is called `default`, which is
 * what the rows and the URL must name too.
 */
export function officeObjectName(projectId: string): string {
  return sessionNameFor(nameOf(projectId));
}

/**
 * The project id a workspace id names, whether the caller has the graph's id or the raw one.
 *
 * @param workspaceId - A raw project id, or the graph's `Project:<base64url>`.
 * @returns The raw project id.
 *
 * @remarks
 * The office fields' arguments carry the graph's workspace id; the control database, the Session
 * and Workspace objects and the machine's ROOT are named by the raw project id (D080). This
 * function is that one step, and every place that crosses between the two reads it here.
 */
export function officeProjectId(workspaceId: string): string {
  return nameOf(workspaceId);
}

/** A graph workspace id's project id, or the value itself when it is already one. */
function nameOf(workspaceId: string): string {
  const decoded = fromGlobalId(workspaceId);
  return decoded.ok && decoded.value.type === "Project" ? decoded.value.id : workspaceId;
}

/**
 * The workspace an office row is keyed by, for one project (0237).
 *
 * @param projectId - The project id a request names.
 * @returns The workspace the object stores the project's rows under, and the `workspaceId` every
 * office URL carries.
 *
 * @remarks
 * The Session object's own name is the workspace: the object checks a request's `workspaceId`
 * against its name, and its rows are keyed by it. The legacy default project's id and its object
 * name differ (`default` is both today, but a deployment that renamed the legacy object would
 * have them differ), so this is the one place both are derived from one another.
 */
export function officeWorkspaceOf(projectId: string): string {
  return officeObjectName(projectId);
}

/**
 * The URL one ready preview is read at (0237).
 *
 * @param row - The workspace, the path, and the version the row records.
 * @returns `{@link OFFICE_PREVIEW_PATH}?workspaceId=…&path=…&v=…`.
 *
 * @remarks
 * The path travels as a query value, so no `/` encoding rule is invented for it. The
 * `workspaceId` is the workspace the rows are keyed by, which is the object's name: the route
 * resolves the id to that object with {@link officeObjectName} and the object checks the value
 * against its own name, so the URL and the route cannot address different objects.
 */
export function previewUrl(row: {
  readonly workspaceId: string;
  readonly path: string;
  readonly version: string;
}): string {
  const query = new URLSearchParams({
    workspaceId: row.workspaceId,
    path: row.path,
    v: row.version,
  });
  return OFFICE_PREVIEW_PATH + "?" + query.toString();
}
