import { Drawer } from "@base-ui/react/drawer";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import type { ConversationLink, ProjectLink, TaskLink } from "./viewModel.ts";
import { toGlobalId } from "@hns/core/graphql";
import { useFragment, useLazyLoadQuery } from "react-relay";
import type { ShellProjectsQuery as ShellProjectsQueryType } from "../__generated__/ShellProjectsQuery.graphql";
import type { ShellWorkspaceQuery as ShellWorkspaceQueryType } from "../__generated__/ShellWorkspaceQuery.graphql";
import type { SidebarConversations$key } from "../__generated__/SidebarConversations.graphql";
import type { SidebarProjects$key } from "../__generated__/SidebarProjects.graphql";
import type { SidebarTasks$key } from "../__generated__/SidebarTasks.graphql";
import { Button } from "../components/Button.tsx";
import { projectIdFrom } from "../routes/ids.ts";
import { formatHash } from "../routes/route.ts";
import { navigate, replaceRoute, useRoute } from "../routes/useRoute.ts";
import { ConnectionStatus } from "./ConnectionStatus.tsx";
import type { LiveSocketFactory } from "../live/client.ts";
import { LiveConnection } from "./LiveConnection.tsx";
import { ProjectWorkspaceProvider, type ProjectWorkspace } from "./ProjectWorkspace.tsx";
import { QueryBoundary } from "./QueryBoundary.tsx";
import {
  Sidebar,
  SidebarConversationsFragment,
  SidebarProjectsFragment,
  SidebarTasksFragment,
} from "./Sidebar.tsx";
import { THEME_LABELS, THEMES, useTheme } from "./theme.ts";
import { TopBar } from "./TopBar.tsx";
import { useMediaQuery } from "./useMediaQuery.ts";
import { conversationLinkOf, projectLinkOf, taskLinkOf } from "./viewModel.ts";
import { totalsOf, type WorkspaceSummary } from "./workspaceSummary.ts";
import { ShellProjectsQuery } from "./ShellProjects.ts";
import { ShellWorkspaceQuery } from "./ShellWorkspace.ts";
import "./shell.css";

export interface ShellProps {
  /** The command palette mounts later; until then the entries render disabled. */
  readonly onOpenCommand?: (() => void) | undefined;
  /** The right panel mounts later; the shell only provides the slot. */
  readonly panel?: ReactNode;
  /** Fixture-only until the overview API returns cross-workspace counts. */
  readonly summarySource?: (() => Promise<readonly WorkspaceSummary[]>) | undefined;
  /**
   * The live socket factory.
   *
   * @remarks
   * Production passes the browser's WebSocket; tests leave it out, so a conversation route
   * never opens a network connection. 0105 moves the subscription into the conversation screen.
   */
  readonly liveSocket?: LiveSocketFactory | undefined;
}

/**
 * The app shell.
 *
 * @remarks
 * Reads are Relay's: the shell runs the two queries and the sidebar owns the fragments that
 * select what it renders. A failed read throws and becomes the boundary's screen, so the shell
 * never renders half a workspace.
 */
export function Shell(props: ShellProps): ReactElement {
  return (
    <QueryBoundary>
      <ShellData {...props} />
    </QueryBoundary>
  );
}

/** Run the shell's two reads and hand the fragment refs to the frame. */
function ShellData({ onOpenCommand, panel, summarySource, liveSocket }: ShellProps): ReactElement {
  const route = useRoute();
  const projectKey = route.projectId === null ? null : projectIdFrom(route.projectId);
  const hasProject = projectKey !== null;

  const projects = useLazyLoadQuery<ShellProjectsQueryType>(
    ShellProjectsQuery,
    {},
    {
      fetchPolicy: "store-or-network",
    },
  );
  const workspace = useLazyLoadQuery<ShellWorkspaceQueryType>(
    ShellWorkspaceQuery,
    {
      // The argument is non-null; the field is skipped when no project is selected.
      projectId: toGlobalId("Project", projectKey ?? "default"),
      hasProject,
    },
    { fetchPolicy: "store-or-network" },
  );

  const projectsRef = projects.projects.__typename === "ProjectList" ? projects.projects : null;
  const conversations = workspace.conversations;
  const conversationsRef =
    conversations !== undefined && conversations.__typename === "ConversationList"
      ? conversations
      : null;
  const tasks = workspace.tasks;
  const tasksRef = tasks !== undefined && tasks.__typename === "TaskList" ? tasks : null;

  return (
    <ShellFrame
      onOpenCommand={onOpenCommand}
      panel={panel}
      summarySource={summarySource}
      projectsRef={projectsRef}
      projectsFailed={projectsRef === null}
      conversationsRef={conversationsRef}
      conversationsFailed={hasProject && conversationsRef === null}
      tasksRef={tasksRef}
      tasksFailed={hasProject && tasksRef === null}
      liveSocket={liveSocket}
    />
  );
}

interface ShellFrameProps extends ShellProps {
  readonly projectsRef: SidebarProjects$key | null;
  readonly projectsFailed: boolean;
  readonly conversationsRef: SidebarConversations$key | null;
  readonly conversationsFailed: boolean;
  readonly tasksRef: SidebarTasks$key | null;
  readonly tasksFailed: boolean;
}

/** The presentational shell: top bar, sidebar, main region, and the drawer. */
function ShellFrame({
  onOpenCommand,
  panel,
  summarySource,
  projectsRef,
  projectsFailed,
  conversationsRef,
  conversationsFailed,
  tasksRef,
  tasksFailed,
  liveSocket,
}: ShellFrameProps): ReactElement {
  const route = useRoute();
  const mobile = useMediaQuery("(max-width: 768px)");
  const [theme, chooseTheme] = useTheme();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const rawProjectId = route.projectId;
  const projectKey = rawProjectId === null ? null : projectIdFrom(rawProjectId);

  const projects = (useFragment(SidebarProjectsFragment, projectsRef)?.projects ?? []).map(
    projectLinkOf,
  );
  const conversations = (
    useFragment(SidebarConversationsFragment, conversationsRef)?.conversations ?? []
  ).map(conversationLinkOf);
  const tasks = (useFragment(SidebarTasksFragment, tasksRef)?.tasks ?? []).map(taskLinkOf);

  const summaries = useQuery({
    queryKey: ["workspace-summaries"],
    enabled: summarySource !== undefined,
    queryFn: () => (summarySource === undefined ? Promise.resolve([]) : summarySource()),
  });

  // The first project is the workspace default; replace so Back does not land on "#/".
  useEffect(() => {
    if (route.kind !== "workspace" || route.projectId !== null) return;
    const first = projects[0];
    if (first !== undefined) replaceRoute({ kind: "workspace", projectId: first.id });
  }, [projects, route]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [route]);

  const project =
    rawProjectId === null ? undefined : projects.find((item) => item.id === rawProjectId);
  const conversationTitle =
    route.kind === "conversation"
      ? conversations.find((item) => item.id === route.conversationId)?.title
      : undefined;
  const location = route.kind === "conversation" ? (conversationTitle ?? "会話") : "Workspace";
  const title =
    route.kind === "conversation" ? (conversationTitle ?? "会話") : (project?.name ?? "Workspace");

  const totals = totalsOf(summaries.data ?? []);
  const connection = projectsFailed ? "offline" : "online";
  const failed = conversationsFailed || tasksFailed;
  const workspaceContext: ProjectWorkspace | null =
    project === undefined
      ? null
      : {
          projectId: project.id,
          workspaceRoot: project.workspace_root,
          agentCwd: project.agent_cwd,
        };

  const sidebar = (
    <Sidebar
      projectsRef={projectsRef}
      conversationsRef={conversationsRef}
      tasksRef={tasksRef}
      runs={[]}
      summaries={summaries.data ?? []}
      summariesPending={summarySource !== undefined && summaries.isPending}
      projectsFailed={projectsFailed}
      route={route}
      failed={failed}
      onClose={mobile ? () => setDrawerOpen(false) : undefined}
    />
  );

  return (
    <div className="hns-shell" data-panel={panel === undefined ? "closed" : "open"}>
      <TopBar
        projectName={project?.name ?? "プロジェクト"}
        projects={projects}
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

      <ProjectWorkspaceProvider workspace={workspaceContext}>
        <main className="hns-shell__main">
          {rawProjectId === null ? (
            <EmptyState title="プロジェクトを選択" body="上のメニューからプロジェクトを選ぶ。" />
          ) : projectKey === null ? (
            <EmptyState
              title="プロジェクトが見つかりません"
              body="URL のプロジェクト ID が不正。"
            />
          ) : project === undefined ? (
            <EmptyState title="プロジェクトが見つかりません" body="サイドバーから選び直す。" />
          ) : route.kind === "conversation" ? (
            <ConversationView
              project={project}
              conversationId={route.conversationId}
              title={conversationTitle}
              liveSocket={liveSocket}
            />
          ) : (
            <WorkspaceView project={project} conversations={conversations} tasks={tasks} />
          )}
        </main>

        {panel === undefined ? null : (
          <aside className="hns-shell__panel" aria-label="エディタパネル">
            {panel}
          </aside>
        )}
      </ProjectWorkspaceProvider>

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
  readonly project: ProjectLink;
  readonly conversations: readonly ConversationLink[];
  readonly tasks: readonly TaskLink[];
}

function WorkspaceView({ project, conversations, tasks }: WorkspaceViewProps): ReactElement {
  const root = project.workspace_root === "" ? "machine ROOT" : project.workspace_root;
  return (
    <section className="hns-view" aria-labelledby="workspace-title">
      <h1 id="workspace-title">Workspace</h1>
      <p className="hns-view__meta">
        {project.name} · 会話 {conversations.length} · タスク {tasks.length}
      </p>
      <p className="hns-view__root" data-project-root={project.workspace_root}>
        root: {root}
      </p>
      <p className="hns-view__note">Workspace の中身はこれから作る。ここは shell の確認用。</p>
    </section>
  );
}

interface ConversationViewProps {
  readonly project: ProjectLink;
  readonly conversationId: string;
  readonly title: string | undefined;
  readonly liveSocket: LiveSocketFactory | undefined;
}

function ConversationView({
  project,
  conversationId,
  title,
  liveSocket,
}: ConversationViewProps): ReactElement {
  return (
    <section className="hns-view" aria-labelledby="conversation-title">
      <h1 id="conversation-title">{title ?? "会話"}</h1>
      <p className="hns-view__meta">
        {project.name} · {conversationId}
      </p>
      {liveSocket === undefined ? null : (
        <LiveConnection
          conversationId={conversationId}
          projectId={project.id}
          socket={liveSocket}
        />
      )}
      <a className="hns-view__link" href={formatHash({ kind: "workspace", projectId: project.id })}>
        ワークスペースへ戻る
      </a>
      <p className="hns-view__note">Conversation の中身はこれから作る。</p>
    </section>
  );
}
