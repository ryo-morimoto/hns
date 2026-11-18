import type { TaskStatus, WorkflowRun } from "@hns/core";
import type { ReactElement } from "react";
import { graphql, useFragment } from "react-relay";
import type { SidebarConversations$key } from "../__generated__/SidebarConversations.graphql";
import type { SidebarProjects$key } from "../__generated__/SidebarProjects.graphql";
import type { SidebarTasks$key } from "../__generated__/SidebarTasks.graphql";
import { Badge } from "../components/Badge.tsx";
import { Button } from "../components/Button.tsx";
import { Icon } from "../components/Icon.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { formatHash, type Route } from "../routes/route.ts";
import { formatRelative } from "./relativeTime.ts";
import { conversationLinkOf, projectLinkOf, taskLinkOf, type ProjectLink } from "./viewModel.ts";
import { breakdownOf, totalsOf, type WorkspaceSummary } from "./workspaceSummary.ts";

/** The sidebar selects the fields it renders; the shell spreads the fragment. */
export const SidebarProjectsFragment = graphql`
  fragment SidebarProjects on ProjectList {
    projects {
      id
      name
      workspaceRoot
      agentCwd
    }
  }
`;

/** The conversations of the selected workspace. */
export const SidebarConversationsFragment = graphql`
  fragment SidebarConversations on ConversationList {
    conversations {
      id
      projectId
      title
    }
  }
`;

/** The tasks of the selected workspace. */
export const SidebarTasksFragment = graphql`
  fragment SidebarTasks on TaskList {
    tasks {
      id
      title
      status
    }
  }
`;

export interface SidebarProps {
  readonly projectsRef: SidebarProjects$key | null;
  readonly conversationsRef: SidebarConversations$key | null;
  readonly tasksRef: SidebarTasks$key | null;
  readonly runs: readonly WorkflowRun[];
  readonly summaries: readonly WorkspaceSummary[];
  readonly summariesPending: boolean;
  /** True when the shell's project read returned a typed failure. */
  readonly projectsFailed: boolean;
  readonly route: Route;
  /** True when the selected workspace's read returned a typed failure. */
  readonly failed: boolean;
  readonly onClose?: (() => void) | undefined;
}

type Tone = "neutral" | "accent" | "ok" | "warn" | "danger";

function taskTone(status: TaskStatus): Tone {
  switch (status) {
    case "todo":
      return "neutral";
    case "doing":
      return "accent";
    case "done":
      return "ok";
    case "blocked":
      return "danger";
  }
}

function runTone(status: WorkflowRun["status"]): Tone {
  switch (status) {
    case "queued":
      return "neutral";
    case "running":
      return "accent";
    case "waiting":
      return "warn";
    case "done":
      return "ok";
    case "failed":
      return "danger";
  }
}

function statusOf(summary: WorkspaceSummary): string {
  const parts: string[] = [];
  if (summary.needsYou > 0) parts.push(String(summary.needsYou) + " needs");
  if (summary.failed > 0) parts.push(String(summary.failed) + " failed");
  if (summary.running > 0) parts.push(String(summary.running) + " running");
  if (parts.length === 0) parts.push("all clear");
  return parts.join(" · ") + " · " + formatRelative(summary.lastActivityAt);
}

function lastTime(summary: WorkspaceSummary | undefined): number {
  if (summary === undefined || summary.lastActivityAt === null) return 0;
  const time = Date.parse(summary.lastActivityAt);
  return Number.isNaN(time) ? 0 : time;
}

function sortProjects(
  projects: readonly ProjectLink[],
  activeId: string | null,
  summaries: ReadonlyMap<string, WorkspaceSummary>,
): readonly ProjectLink[] {
  return [...projects].sort((a, b) => {
    if ((a.id === activeId) !== (b.id === activeId)) return a.id === activeId ? -1 : 1;
    const left = summaries.get(a.id);
    const right = summaries.get(b.id);
    const needs = (right?.needsYou ?? 0) - (left?.needsYou ?? 0);
    if (needs !== 0) return needs;
    const failed = (right?.failed ?? 0) - (left?.failed ?? 0);
    if (failed !== 0) return failed;
    const running = (right?.running ?? 0) - (left?.running ?? 0);
    if (running !== 0) return running;
    const activity = lastTime(right) - lastTime(left);
    if (activity !== 0) return activity;
    return a.name.localeCompare(b.name);
  });
}

interface SummaryRowProps {
  readonly label: string;
  readonly count: number;
  readonly breakdown: string;
  readonly critical?: boolean | undefined;
}

function SummaryRow({ label, count, breakdown, critical = false }: SummaryRowProps): ReactElement {
  return (
    <div
      className="hns-summary__row"
      role="group"
      data-tone={critical && count > 0 ? "critical" : "normal"}
      aria-label={
        breakdown === ""
          ? label + ": " + String(count)
          : label + ": " + String(count) + " (" + breakdown + ")"
      }
    >
      <span className="hns-summary__label" aria-hidden="true">
        {label}
      </span>
      <span className="hns-summary__count" aria-hidden="true">
        {count > 99 ? "99+" : String(count)}
      </span>
      <span className="hns-summary__breakdown" aria-hidden="true">
        {breakdown}
      </span>
    </div>
  );
}

export function Sidebar({
  projectsRef,
  conversationsRef,
  tasksRef,
  runs,
  summaries,
  summariesPending,
  projectsFailed,
  route,
  failed,
  onClose,
}: SidebarProps): ReactElement {
  const projects = (useFragment(SidebarProjectsFragment, projectsRef)?.projects ?? []).map(
    projectLinkOf,
  );
  const conversations = (
    useFragment(SidebarConversationsFragment, conversationsRef)?.conversations ?? []
  ).map(conversationLinkOf);
  const tasks = (useFragment(SidebarTasksFragment, tasksRef)?.tasks ?? []).map(taskLinkOf);
  const projectId = route.projectId;
  const currentConversation = route.kind === "conversation" ? route.conversationId : null;
  const summaryById = new Map<string, WorkspaceSummary>(
    summaries.map((summary) => [summary.projectId, summary]),
  );
  const totals = totalsOf(summaries);
  const ordered = sortProjects(projects, projectId, summaryById);

  return (
    <nav aria-label="サイドバー" className="hns-sidebar">
      <div className="hns-sidebar__header">
        <span className="hns-sidebar__brand">hns</span>
        {onClose === undefined ? null : (
          <Button variant="icon" aria-label="メニューを閉じる" onClick={onClose}>
            <Icon name="close" />
          </Button>
        )}
      </div>

      {summaries.length === 0 && !summariesPending ? null : (
        <section className="hns-sidebar__section" aria-label="全体の状態">
          <h2 className="hns-sidebar__title">All workspaces</h2>
          {summariesPending ? (
            <Skeleton width="80%" height={10} />
          ) : (
            <div className="hns-summary">
              <SummaryRow
                label="Needs you"
                count={totals.needsYou}
                breakdown={breakdownOf(summaries, "needsYou")}
                critical
              />
              <SummaryRow
                label="Failed"
                count={totals.failed}
                breakdown={breakdownOf(summaries, "failed")}
                critical
              />
              <SummaryRow
                label="Running"
                count={totals.running}
                breakdown={breakdownOf(summaries, "running")}
              />
              <SummaryRow
                label="Done today"
                count={totals.doneToday}
                breakdown={breakdownOf(summaries, "doneToday")}
              />
            </div>
          )}
        </section>
      )}

      <section className="hns-sidebar__section" aria-label="ワークスペース">
        <h2 className="hns-sidebar__title">ワークスペース</h2>
        {projectsFailed ? <p className="hns-sidebar__empty">読み込めません</p> : null}
        {!projectsFailed && ordered.length === 0 ? (
          <p className="hns-sidebar__empty">ワークスペースがありません</p>
        ) : null}
        <ul className="hns-sidebar__list">
          {ordered.map((project) => {
            const summary = summaryById.get(project.id);
            const active = project.id === projectId;
            return (
              <li
                className="hns-workspace"
                data-active={active ? "true" : "false"}
                key={project.id}
              >
                <a
                  className="hns-workspace__link"
                  href={formatHash({ kind: "workspace", projectId: project.id })}
                  aria-current={active && route.kind === "workspace" ? "page" : undefined}
                  aria-label={
                    summary === undefined ? project.name : project.name + ": " + statusOf(summary)
                  }
                >
                  <span className="hns-workspace__name">{project.name}</span>
                  {summary === undefined ? null : (
                    <span className="hns-workspace__status" aria-hidden="true">
                      {statusOf(summary)}
                    </span>
                  )}
                </a>
                {active ? (
                  <div
                    className="hns-workspace__body"
                    role="group"
                    aria-label={project.name + " の作業"}
                  >
                    <h3 className="hns-sidebar__subtitle">会話</h3>
                    {failed ? <p className="hns-sidebar__empty">読み込めません</p> : null}
                    {!failed && conversations.length === 0 ? (
                      <p className="hns-sidebar__empty">会話はありません</p>
                    ) : null}
                    <ul className="hns-sidebar__list">
                      {conversations.map((conversation) => (
                        <li key={conversation.id}>
                          <a
                            className="hns-sidebar__link"
                            href={formatHash({
                              kind: "conversation",
                              projectId: conversation.project_id,
                              conversationId: conversation.id,
                            })}
                            aria-current={
                              currentConversation === conversation.id ? "page" : undefined
                            }
                          >
                            {conversation.title}
                          </a>
                        </li>
                      ))}
                    </ul>
                    <h3 className="hns-sidebar__subtitle">タスク</h3>
                    <ul className="hns-sidebar__list">
                      {tasks.map((task) => (
                        <li className="hns-sidebar__row" key={task.id}>
                          <Badge tone={taskTone(task.status)}>{task.status}</Badge>
                          <span>{task.title}</span>
                        </li>
                      ))}
                    </ul>
                    <a
                      className="hns-sidebar__link"
                      href={formatHash({ kind: "policy", projectId: project.id })}
                      aria-current={route.kind === "policy" ? "page" : undefined}
                    >
                      ポリシー
                    </a>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="hns-sidebar__section" aria-label="実行">
        <h2 className="hns-sidebar__title">実行</h2>
        {runs.length === 0 ? <p className="hns-sidebar__empty">実行はありません</p> : null}
        <ul className="hns-sidebar__list">
          {runs.map((run) => (
            <li className="hns-sidebar__row" key={run.id}>
              <Badge tone={runTone(run.status)}>{run.status}</Badge>
              <span>{run.workflow_id}</span>
            </li>
          ))}
        </ul>
      </section>
    </nav>
  );
}
