import type { Conversation, Project, ProjectId, Task, WorkflowRun } from "@hns/core";

/**
 * The shell's read surface.
 *
 * @remarks
 * The shell owns no fetching policy: it asks for model data and renders loading, error, and
 * empty states. The fixture implementation stands in until Relay owns the reads (0178).
 */
export interface WorkspaceSource {
  readonly listProjects: () => Promise<readonly Project[]>;
  readonly listConversations: (projectId: ProjectId) => Promise<readonly Conversation[]>;
  readonly listTasks: (projectId: ProjectId) => Promise<readonly Task[]>;
  readonly listRuns: () => Promise<readonly WorkflowRun[]>;
}
