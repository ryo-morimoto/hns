import { Drawer } from "@base-ui/react/drawer";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import type { Conversation, Project, Task } from "@hns/core";
import type { WebClient } from "../api/client.ts";
import { Button } from "../components/Button.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { projectIdFrom } from "../routes/ids.ts";
import { formatHash } from "../routes/route.ts";
import { navigate, replaceRoute, useRoute } from "../routes/useRoute.ts";
import { ConnectionStatus } from "./ConnectionStatus.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { THEME_LABELS, THEMES, useTheme } from "./theme.ts";
import { TopBar } from "./TopBar.tsx";
import { useMediaQuery } from "./useMediaQuery.ts";
import { totalsOf, type WorkspaceSummary } from "./workspaceSummary.ts";
import "./shell.css";

export interface ShellProps {
  readonly client: WebClient;
  /** 0103 mounts the palette; until then the entries render disabled. */
  readonly onOpenCommand?: (() => void) | undefined;
  /** 0106 reserves the right panel; the shell only provides the slot. */
  readonly panel?: ReactNode;
  /** Fixture-only until 0115 returns cross-workspace counts. */
  readonly summarySource?: (() => Promise<readonly WorkspaceSummary[]>) | undefined;
}

export function Shell({ client, onOpenCommand, panel, summarySource }: ShellProps): ReactElement {
  const route = useRoute();
  const mobile = useMediaQuery("(max-width: 768px)");
  const [theme, chooseTheme] = useTheme();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const rawProjectId = route.projectId;
  const projectKey = rawProjectId === null ? null : projectIdFrom(rawProjectId);

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => client.request("GET /api/projects"),
  });

  const summaries = useQuery({
    queryKey: ["workspace-summaries"],
    enabled: summarySource !== undefined,
    queryFn: () => (summarySource === undefined ? Promise.resolve([]) : summarySource()),
  });

  const conversations = useQuery({
    queryKey: ["conversations", rawProjectId, projectKey],
    enabled: projectKey !== null,
    queryFn: () =>
      client.request("GET /api/conversations", {
        input: projectKey === null ? {} : { projectId: projectKey },
      }),
  });

  const tasks = useQuery({
    queryKey: ["tasks", projectKey],
    enabled: projectKey !== null,
    queryFn: () =>
      client.request("GET /api/tasks", {
        input: projectKey === null ? {} : { projectId: projectKey },
      }),
  });

  // Runs have no project in the API yet, so they stay a global section (not per workspace).
  const runs = useQuery({
    queryKey: ["runs"],
    queryFn: () => client.request("GET /api/runs"),
  });

  // The first project is the workspace default; replace so Back does not land on "#/".
  useEffect(() => {
    if (route.kind !== "workspace" || route.projectId !== null) return;
    const first = projects.data?.[0];
    if (first !== undefined) replaceRoute({ kind: "workspace", projectId: first.id });
  }, [projects.data, route]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [route]);

  const project =
    rawProjectId === null ? undefined : projects.data?.find((item) => item.id === rawProjectId);
  const conversationTitle =
    route.kind === "conversation"
      ? conversations.data?.find((item) => item.id === route.conversationId)?.title
      : undefined;
  const location = route.kind === "conversation" ? (conversationTitle ?? "会話") : "Workspace";
  const title =
    route.kind === "conversation" ? (conversationTitle ?? "会話") : (project?.name ?? "Workspace");

  const totals = totalsOf(summaries.data ?? []);
  const connection = projects.isPending ? "connecting" : projects.isError ? "offline" : "online";
  const loading =
    projects.isPending ||
    (projectKey !== null && (conversations.isPending || tasks.isPending || runs.isPending));
  const failed =
    projects.isError ||
    (projectKey !== null && (conversations.isError || tasks.isError || runs.isError));

  const sidebar = (
    <Sidebar
      projects={projects.data ?? []}
      conversations={conversations.data ?? []}
      tasks={tasks.data ?? []}
      runs={runs.data ?? []}
      summaries={summaries.data ?? []}
      summariesPending={summarySource !== undefined && summaries.isPending}
      projectsPending={projects.isPending}
      projectsFailed={projects.isError}
      runsPending={runs.isPending}
      runsFailed={runs.isError}
      route={route}
      loading={loading}
      failed={failed}
      onClose={mobile ? () => setDrawerOpen(false) : undefined}
    />
  );

  return (
    <div className="hns-shell" data-panel={panel === undefined ? "closed" : "open"}>
      <TopBar
        projectName={project?.name ?? (projects.isPending ? "読み込み中" : "プロジェクト")}
        projects={projects.data ?? []}
        location={location}
        title={title}
        connection={connection}
        theme={theme}
        mobile={mobile}
        onSelectProject={(selected) => navigate({ kind: "workspace", projectId: selected.id })}
        onTheme={chooseTheme}
        menuBadge={totals.needsYou}
        onOpenDrawer={() => setDrawerOpen(true)}
        onBack={
          route.kind === "conversation"
            ? () => navigate({ kind: "workspace", projectId: route.projectId })
            : undefined
        }
        onOpenCommand={onOpenCommand}
      />

      {mobile ? null : sidebar}

      <main className="hns-shell__main">
        {rawProjectId === null ? (
          <EmptyState title="プロジェクトを選択" body="上のメニューからプロジェクトを選ぶ。" />
        ) : projectKey === null ? (
          <EmptyState title="プロジェクトが見つかりません" body="URL のプロジェクト ID が不正。" />
        ) : project === undefined ? (
          projects.isPending ? (
            <Skeleton width={220} height={18} />
          ) : (
            <EmptyState title="プロジェクトが見つかりません" body="サイドバーから選び直す。" />
          )
        ) : route.kind === "conversation" ? (
          <ConversationView
            project={project}
            conversationId={route.conversationId}
            title={conversationTitle}
          />
        ) : (
          <WorkspaceView
            project={project}
            conversations={conversations.data ?? []}
            tasks={tasks.data ?? []}
          />
        )}
      </main>

      {panel === undefined ? null : (
        <aside className="hns-shell__panel" aria-label="エディタパネル">
          {panel}
        </aside>
      )}

      {mobile && drawerOpen ? (
        <Drawer.Root open onOpenChange={setDrawerOpen} swipeDirection="left">
          <Drawer.Portal>
            <Drawer.Backdrop className="hns-drawer-backdrop" />
            <Drawer.Viewport className="hns-drawer-viewport">
              <Drawer.Popup className="hns-drawer-popup">
                <Drawer.Title className="hns-sr-only">メニュー</Drawer.Title>
                <Drawer.Content className="hns-drawer-content">
                  {sidebar}
                  <div className="hns-drawer-footer">
                    <ConnectionStatus connection={connection} />
                    <div className="hns-theme-row" role="group" aria-label="テーマ">
                      {THEMES.map((choice) => (
                        <Button
                          key={choice}
                          variant={theme === choice ? "primary" : "ghost"}
                          aria-pressed={theme === choice}
                          onClick={() => chooseTheme(choice)}
                        >
                          {THEME_LABELS[choice]}
                        </Button>
                      ))}
                    </div>
                  </div>
                </Drawer.Content>
              </Drawer.Popup>
            </Drawer.Viewport>
          </Drawer.Portal>
        </Drawer.Root>
      ) : null}
    </div>
  );
}

interface EmptyStateProps {
  readonly title: string;
  readonly body: string;
}

function EmptyState({ title, body }: EmptyStateProps): ReactElement {
  return (
    <section className="hns-view">
      <h1>{title}</h1>
      <p className="hns-view__note">{body}</p>
    </section>
  );
}

interface WorkspaceViewProps {
  readonly project: Project;
  readonly conversations: readonly Conversation[];
  readonly tasks: readonly Task[];
}

function WorkspaceView({ project, conversations, tasks }: WorkspaceViewProps): ReactElement {
  return (
    <section className="hns-view" aria-labelledby="workspace-title">
      <h1 id="workspace-title">Workspace</h1>
      <p className="hns-view__meta">
        {project.name} · 会話 {conversations.length} · タスク {tasks.length}
      </p>
      <p className="hns-view__note">Workspace の中身は 0104 で作る。ここは shell の確認用。</p>
    </section>
  );
}

interface ConversationViewProps {
  readonly project: Project;
  readonly conversationId: string;
  readonly title: string | undefined;
}

function ConversationView({ project, conversationId, title }: ConversationViewProps): ReactElement {
  return (
    <section className="hns-view" aria-labelledby="conversation-title">
      <h1 id="conversation-title">{title ?? "会話"}</h1>
      <p className="hns-view__meta">
        {project.name} · {conversationId}
      </p>
      <a className="hns-view__link" href={formatHash({ kind: "workspace", projectId: project.id })}>
        ワークスペースへ戻る
      </a>
      <p className="hns-view__note">Conversation の中身は 0105 で作る。</p>
    </section>
  );
}
