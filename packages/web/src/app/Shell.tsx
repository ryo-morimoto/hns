import { Drawer } from "@base-ui/react/drawer";
import { useQuery } from "@tanstack/react-query";
import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ConversationLink, ProjectLink, TrailLink } from "./viewModel.ts";
import { toGlobalId } from "@hns/core/graphql";
import { useFragment, useLazyLoadQuery, useRelayEnvironment } from "react-relay";
import { fetchQuery } from "relay-runtime";
import type { ShellProjectsQuery as ShellProjectsQueryType } from "../__generated__/ShellProjectsQuery.graphql";
import type { ShellWorkspaceQuery as ShellWorkspaceQueryType } from "../__generated__/ShellWorkspaceQuery.graphql";
import type { SidebarConversations$key } from "../__generated__/SidebarConversations.graphql";
import type { SidebarProjects$key } from "../__generated__/SidebarProjects.graphql";
import type { SidebarTrails$key } from "../__generated__/SidebarTrails.graphql";
import { Button } from "../components/Button.tsx";
import { PolicyScreen, PolicyScreenFallback } from "../routes/policy/PolicyScreen.tsx";
import { TrailDetailScreen } from "../routes/trail/TrailDetailScreen.tsx";
import { ConversationScreen } from "../screens/conversation/ConversationScreen.tsx";
import { projectIdFrom } from "../routes/ids.ts";
import { formatHash } from "../routes/route.ts";
import { navigate, replaceRoute, useRoute } from "../routes/useRoute.ts";
import { ConnectionStatus } from "./ConnectionStatus.tsx";
import { useMemo } from "react";
import { fileNameOf, selectionOfRoute, useDocumentTitle } from "./PanelState.ts";
import { PanelContent, panelStore } from "./PanelSlot.tsx";
import type { LiveSocketFactory } from "../live/client.ts";
import { applyLiveFrameToStore, forgetLiveTitle, reapplyLiveTitles } from "../live/store.ts";
import { useLiveConnection } from "../live/useLiveConnection.ts";
import { DEFAULT_FETCH_POLICY, useScreenRead } from "./freshness.ts";
import { LiveConnection } from "./LiveConnection.tsx";
import { ProjectWorkspaceProvider, type ProjectWorkspace } from "./ProjectWorkspace.tsx";
import { QueryBoundary } from "./QueryBoundary.tsx";
import {
  Sidebar,
  SidebarConversationsFragment,
  SidebarProjectsFragment,
  SidebarTrailsFragment,
} from "./Sidebar.tsx";
import { THEME_LABELS, THEMES, useTheme } from "./theme.ts";
import { TopBar } from "./TopBar.tsx";
import { useMediaQuery } from "./useMediaQuery.ts";
import { conversationLinkOf, projectLinkOf, trailLinkOf } from "./viewModel.ts";
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
      {/*
        The right panel's slot. Its content is the document preview, which draws nothing until a
        screen asks for a file; mounting it here is what keeps the preview's code (and the PDF.js
        worker it bundles) in the build, so the first screen that opens a file has a panel to open
        it in. A caller that passes its own panel replaces it (a test, a future second panel).
      */}
      <ShellData {...props} panel={props.panel ?? <PanelContent />} />
    </QueryBoundary>
  );
}

/** Run the shell's two reads and hand the fragment refs to the frame. */
function ShellData({ onOpenCommand, panel, summarySource, liveSocket }: ShellProps): ReactElement {
  const route = useRoute();
  const environment = useRelayEnvironment();
  const projectKey = route.projectId === null ? null : projectIdFrom(route.projectId);
  const hasProject = projectKey !== null;
  // The project list is read again when its window passes; the read writes the same store.
  const revalidateProjects = useCallback(async () => {
    await fetchQuery(environment, ShellProjectsQuery, {}).toPromise();
  }, [environment]);
  const projectsPolicy = useScreenRead(environment, "projects", { revalidate: revalidateProjects });
  const workspacePolicy = useScreenRead(environment, "workspace");
  // A reconnect asks the open screen for a fresh list; the store stays on screen meanwhile.
  const [reloads, setReloads] = useState(0);
  const onReconnect = useCallback(() => {
    setReloads((value) => value + 1);
  }, []);

  const projects = useLazyLoadQuery<ShellProjectsQueryType>(
    ShellProjectsQuery,
    {},
    {
      fetchPolicy: projectsPolicy,
    },
  );
  const workspace = useLazyLoadQuery<ShellWorkspaceQueryType>(
    ShellWorkspaceQuery,
    {
      // The argument is non-null; the field is skipped when no project is selected.
      projectId: toGlobalId("Project", projectKey ?? "default"),
      hasProject,
    },
    {
      // Without a selected project the query selects nothing; asking the network for it would
      // spend a request on an empty answer (0179), so the default policy answers from the store.
      fetchPolicy: hasProject ? workspacePolicy : DEFAULT_FETCH_POLICY,
      // The counter changes only on a reconnect, which is the one case the socket cannot heal.
      fetchKey: "workspace:" + String(reloads),
    },
  );

  const projectsRef = projects.projects.__typename === "ProjectList" ? projects.projects : null;
  const conversations = workspace.conversations;
  const conversationsRef =
    conversations !== undefined && conversations.__typename === "ConversationList"
      ? conversations
      : null;
  const trails = workspace.trails;
  const trailsRef = trails !== undefined && trails.__typename === "TrailList" ? trails : null;

  return (
    <ShellFrame
      onOpenCommand={onOpenCommand}
      panel={panel}
      summarySource={summarySource}
      projectsRef={projectsRef}
      projectsFailed={projectsRef === null}
      conversationsRef={conversationsRef}
      conversationsFailed={hasProject && conversationsRef === null}
      trailsRef={trailsRef}
      trailsFailed={hasProject && trailsRef === null}
      liveSocket={liveSocket}
      onReconnect={onReconnect}
    />
  );
}

interface ShellFrameProps extends ShellProps {
  readonly projectsRef: SidebarProjects$key | null;
  readonly projectsFailed: boolean;
  readonly conversationsRef: SidebarConversations$key | null;
  readonly conversationsFailed: boolean;
  readonly trailsRef: SidebarTrails$key | null;
  readonly trailsFailed: boolean;
  /** Refetch the open screen after the live connection recovers. */
  readonly onReconnect: () => void;
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
  trailsRef,
  trailsFailed,
  liveSocket,
  onReconnect,
}: ShellFrameProps): ReactElement {
  const route = useRoute();
  const environment = useRelayEnvironment();
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
  const trails = (useFragment(SidebarTrailsFragment, trailsRef)?.trails ?? []).map(trailLinkOf);

  // A list read carries the title the server had when it began; the socket's snapshot is newer,
  // so it is put back after every render that could have normalized over it. Re-running is cheap:
  // only titles the store no longer holds are written, so this settles after one extra render.
  useEffect(() => {
    reapplyLiveTitles(environment);
  });

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
  // The document panel's state is the route's: the file the URL names, and the file after it
  // (the workspace's own order, as the open route names it). Both are values, so the panel
  // redraws when the URL changes and writes it through the URL alone.
  const selection = useMemo(() => selectionOfRoute(route), [route]);
  const nextFile = useMemo(() => {
    if (selection === null || selection.path === null) return null;
    const nextPath = nextPathOf(selection.path);
    return nextPath === null ? null : { workspaceId: selection.workspaceId, path: nextPath };
  }, [selection]);
  useDocumentTitle(
    selection === null || selection.path === null ? null : fileNameOf(selection.path),
  );
  // The panel reads this store; the route is the only thing that writes it.
  useEffect(() => {
    panelStore.set({ selection, next: nextFile });
  }, [selection, nextFile]);
  const conversationTitle =
    route.kind === "conversation"
      ? conversations.find((item) => item.id === route.conversationId)?.title
      : undefined;
  const trailTitle =
    route.kind === "trail" ? trails.find((trail) => trail.id === route.trailId)?.title : undefined;
  const location =
    route.kind === "conversation"
      ? (conversationTitle ?? "会話")
      : route.kind === "policy"
        ? "ポリシー"
        : route.kind === "trail"
          ? "Trail"
          : route.kind === "file"
            ? "文書"
            : "Workspace";
  const title =
    route.kind === "conversation"
      ? (conversationTitle ?? "会話")
      : route.kind === "policy"
        ? "ポリシー"
        : route.kind === "trail"
          ? (trailTitle ?? "Trail")
          : route.kind === "file"
            ? route.path === null
              ? "開けないファイル"
              : fileNameOf(route.path)
            : (project?.name ?? "Workspace");

  const totals = totalsOf(summaries.data ?? []);
  const connection = projectsFailed ? "offline" : "online";
  const failed = conversationsFailed || trailsFailed;
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
      trailsRef={trailsRef}
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
          route.kind === "workspace"
            ? undefined
            : () => navigate({ kind: "workspace", projectId: route.projectId })
        }
        onOpenCommand={onOpenCommand}
      />

      {mobile ? null : sidebar}

      <ProjectWorkspaceProvider workspace={workspaceContext}>
        {/*
          The main region is focusable but not in the tab order: when a control that was on
          screen goes away (a decided proposal, a failed send), focus moves here rather than to
          <body>, so a keyboard user keeps their place.
        */}
        <main className="hns-shell__main" tabIndex={-1}>
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
              onReconnect={onReconnect}
            />
          ) : route.kind === "policy" ? (
            <PolicyView project={project} />
          ) : route.kind === "trail" ? (
            <TrailDetailScreen trailId={route.trailId} />
          ) : route.kind === "file" ? (
            <FileView project={project} path={route.path} />
          ) : (
            <WorkspaceView project={project} conversations={conversations} trails={trails} />
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
  readonly trails: readonly TrailLink[];
}

function WorkspaceView({ project, conversations, trails }: WorkspaceViewProps): ReactElement {
  const root = project.workspace_root === "" ? "machine ROOT" : project.workspace_root;
  return (
    <section className="hns-view" aria-labelledby="workspace-title">
      <h1 id="workspace-title">Workspace</h1>
      <p className="hns-view__meta">
        {project.name} · 会話 {conversations.length} · Trail {trails.length}
      </p>
      <p className="hns-view__root" data-project-root={project.workspace_root}>
        root: {root}
      </p>
      <p className="hns-view__note">Workspace の中身はこれから作る。ここは shell の確認用。</p>
    </section>
  );
}

/**
 * The main region's face for an open file: what the panel is showing, and where it came from.
 *
 * @remarks
 * **The panel is the reader; this is the address.** A file opened from a hash has no list to go
 * back to yet (the workspace's file list is 0125 / 0104), so the region says which file the URL
 * names and offers the workspace it is in, which is a route the sidebar also has. The path is
 * the route's: the panel and this sentence cannot disagree about which file is open.
 */
function FileView({
  project,
  path,
}: {
  readonly project: ProjectLink;
  readonly path: string | null;
}): ReactElement {
  return (
    <section className="hns-view" aria-labelledby="file-title">
      <h1 id="file-title">文書</h1>
      <p className="hns-view__meta" data-file-path={path ?? ""}>
        {path === null ? (
          "このパスは workspace の外を指しているので開けません。"
        ) : (
          <>
            {project.name} の <code>{path}</code> を右のパネルで表示中。
          </>
        )}
      </p>
      <p className="hns-view__note">
        <a href={formatHash({ kind: "workspace", projectId: project.id })}>workspace に戻る</a>
      </p>
    </section>
  );
}

/**
 * The file after one in the workspace, as the hash route names it, or null.
 *
 * @param path - The open file's workspace-relative path.
 * @returns The next file's path, or null when the route names none.
 *
 * @remarks
 * **The order is the URL's own**: a document opened from a hash carries the list it belongs to
 * as the `files` query (`#/p/<project>/doc/<path>?files=<a>&files=<b>`). The next file is the one
 * after this file in that order, and nothing when the route names no list — the shell does not
 * invent an order (a file list is 0125 / 0104's to define).
 */
function nextPathOf(path: string): string | null {
  const params = new URLSearchParams(window.location.search);
  const files = params.getAll("files");
  const at = files.indexOf(path);
  const next = at === -1 ? undefined : files[at + 1];
  return next === undefined || next === "" ? null : next;
}

/**
 * The workspace's policy route.
 *
 * @remarks
 * **The principal is not this screen's to know.** This build has no endpoint that names the
 * signed-in subject (the edge verifies the cookie; 0108's login face adds the read), so the route
 * cannot tell an agent session from a person's from the client alone, and it says so: the
 * decision is offered to whoever the page is, and the face's `policy_denied` is the refusal that
 * counts. When the session read lands, the route passes `canDecide` from it; the screen's
 * no-permission state is already drawn for that value.
 *
 * The read is the one thing this route adds; the conversation's live socket belongs to a
 * conversation's visit and is not opened here.
 */
function PolicyView({ project }: { readonly project: ProjectLink }): ReactElement {
  return (
    <Suspense fallback={<PolicyScreenFallback />}>
      <PolicyScreen workspaceId={toGlobalId("Project", project.id)} canDecide />
    </Suspense>
  );
}

interface ConversationViewProps {
  readonly project: ProjectLink;
  readonly conversationId: string;
  readonly title: string | undefined;
  readonly liveSocket: LiveSocketFactory | undefined;
  readonly onReconnect: () => void;
}

/**
 * The conversation route, and the one live connection its visit has.
 *
 * @remarks
 * **One visit, one client, one socket.** The route creates the conversation's `LiveClient`
 * here — not inside the screen — so the visit has a single connection: its frames patch the
 * Relay store (the sidebar's title), its status is the line above the transcript, and the same
 * client carries the screen's sends and stops. Two clients for one conversation would be two
 * subscribers on the object, two reconnects racing, and two connections to count.
 *
 * The route also owns what the screen does not: the title in the chrome (it must show before
 * the screen's read finishes, and it tracks a rename), and the reconnect report upward so the
 * shell refetches the lists. The transcript, the composer, and the draft are the screen's.
 */
function ConversationView({
  project,
  conversationId,
  title,
  liveSocket,
  onReconnect,
}: ConversationViewProps): ReactElement {
  const environment = useRelayEnvironment();
  // Hooks are unconditional: a shell with no socket still calls the hook, and `enabled` is
  // what keeps it from opening one the shell did not offer.
  const live = useLiveConnection(conversationId, {
    projectId: project.id,
    socket: liveSocket,
    enabled: liveSocket !== undefined,
    onFrame: (frame) => {
      applyLiveFrameToStore(environment, frame);
    },
  });
  const previous = useRef(live.state.status);

  useEffect(() => {
    const reconnected = previous.current === "reconnecting" && live.state.status === "online";
    previous.current = live.state.status;
    if (reconnected) onReconnect();
  }, [live.state.status, onReconnect]);

  useEffect(() => {
    return () => {
      forgetLiveTitle(environment, conversationId);
    };
  }, [environment, conversationId]);

  return (
    <section className="hns-view" aria-labelledby="conversation-title">
      <h1 id="conversation-title" className="hns-sr-only">
        {title ?? "会話"}
      </h1>
      {liveSocket === undefined ? null : (
        // The status, the sidebar's title, and the screen's commands are all this one
        // connection; nothing below opens another.
        <LiveConnection state={live.state} label />
      )}
      <ConversationScreen
        conversationId={conversationId}
        projectId={project.id}
        client={live.client}
      />
    </section>
  );
}
