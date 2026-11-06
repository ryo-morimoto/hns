import type { Conversation, Project, Task, WorkflowRun } from "@hns/core";
import type { ReactElement } from "react";
import { Badge } from "../components/Badge.tsx";
import { Button } from "../components/Button.tsx";
import { Icon } from "../components/Icon.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { formatHash, type Route } from "../routes/route.ts";

export interface SidebarProps {
  readonly projects: readonly Project[];
  readonly conversations: readonly Conversation[];
  readonly tasks: readonly Task[];
  readonly runs: readonly WorkflowRun[];
  readonly route: Route;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly onClose?: (() => void) | undefined;
}

type Tone = "neutral" | "accent" | "ok" | "warn" | "danger";

function taskTone(status: Task["status"]): Tone {
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

export function Sidebar({
  projects,
  conversations,
  tasks,
  runs,
  route,
  loading,
  failed,
  onClose,
}: SidebarProps): ReactElement {
  const projectId = route.projectId;
  const currentConversation = route.kind === "conversation" ? route.conversationId : null;

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

      <section className="hns-sidebar__section">
        <h2 className="hns-sidebar__title">ワークスペース</h2>
        <ul className="hns-sidebar__list">
          {projects.map((project) => (
            <li key={project.id}>
              <a
                className="hns-sidebar__link"
                href={formatHash({ kind: "workspace", projectId: project.id })}
                aria-current={
                  projectId === project.id && route.kind === "workspace" ? "page" : undefined
                }
              >
                {project.name}
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section className="hns-sidebar__section">
        <h2 className="hns-sidebar__title">会話</h2>
        {loading ? <Skeleton width="80%" height={10} /> : null}
        {failed ? <p className="hns-sidebar__empty">読み込めません</p> : null}
        {!loading && !failed && conversations.length === 0 ? (
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
                aria-current={currentConversation === conversation.id ? "page" : undefined}
              >
                {conversation.title}
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section className="hns-sidebar__section">
        <h2 className="hns-sidebar__title">タスク</h2>
        <ul className="hns-sidebar__list">
          {tasks.map((task) => (
            <li className="hns-sidebar__row" key={task.id}>
              <Badge tone={taskTone(task.status)}>{task.status}</Badge>
              <span>{task.title}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="hns-sidebar__section">
        <h2 className="hns-sidebar__title">実行</h2>
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
