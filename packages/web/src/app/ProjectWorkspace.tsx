import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import type { ProjectId } from "@hns/core";

/**
 * The selected project's file context.
 *
 * @remarks
 * The shell is the only place that knows which project is open. The editor panel (0106) and
 * the workspace screen read this instead of parsing the route again, so a switch changes every
 * target at once: the project id, the workspace root below the machine ROOT, and the agent's
 * cwd. Null means no project is selected.
 */
export interface ProjectWorkspace {
  readonly projectId: ProjectId;
  /** The project's directory below the machine ROOT; empty is the ROOT itself. */
  readonly workspaceRoot: string;
  /** The directory the agent starts in; equal to `workspaceRoot`. */
  readonly agentCwd: string;
}

const ProjectWorkspaceContext = createContext<ProjectWorkspace | null>(null);

/** Provide the selected project to the main region and the editor panel. */
export function ProjectWorkspaceProvider({
  workspace,
  children,
}: {
  readonly workspace: ProjectWorkspace | null;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <ProjectWorkspaceContext.Provider value={workspace}>
      {children}
    </ProjectWorkspaceContext.Provider>
  );
}

/** The selected project, or null when the route names none. */
export function useProjectWorkspace(): ProjectWorkspace | null {
  return useContext(ProjectWorkspaceContext);
}
