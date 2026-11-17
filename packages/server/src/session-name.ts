/** The Durable Object name the deployment used before projects had roots. */
export const LEGACY_SESSION_NAME = "default";

/**
 * The Session Durable Object name for a project.
 *
 * @param projectId - The project's raw id (not a global id).
 * @returns The object name, which is the project id.
 * @throws Error when `projectId` is empty, because an unnamed object would merge projects.
 *
 * @remarks
 * One project is one Session object (D080): the name is the project id, so two projects can
 * never share conversations. The default project's id is `"default"`, which is the name the
 * deployment used before this rule, so existing conversations on that object stay reachable.
 * This function is the one place that decides the name; the edge, the GraphQL resolvers, and
 * the web live client all go through it.
 */
export function sessionNameFor(projectId: string): string {
  if (projectId.length === 0) throw new Error("a session needs a project id");
  return projectId;
}
