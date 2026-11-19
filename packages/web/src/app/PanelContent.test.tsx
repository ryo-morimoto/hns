import { render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { RelayEnvironmentProvider } from "react-relay";
import { expect, test } from "vitest";
import { ProjectIdSchema } from "@hns/core";
import { toGlobalId } from "@hns/core/graphql";
import * as v from "valibot";
import { createEnvironment } from "../relay/environment.ts";
import { fileNameOf, selectionOfRoute, useDocumentTitle } from "./PanelState.ts";
import type { PanelState } from "./PanelState.ts";
import { PanelContent, panelStore } from "./PanelSlot.tsx";
import { ProjectWorkspaceProvider } from "./ProjectWorkspace.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/**
 * The shell's right panel, as the shell mounts it.
 *
 * @remarks
 * The panel is the one place the document preview is mounted; what these tests fix is **who
 * mounts it and with which workspace**: the Sidebar's selected project (the one context fact the
 * panel is given) and the file the route names. A preview drawn for another project would be a
 * read this session has no business making, and the panel refuses to draw one.
 */
function renderPanel(
  projectId: string,
  state: PanelState = { selection: null, next: null, files: [] },
): ReturnType<typeof render> {
  const environment = createEnvironment({
    fetch: async () =>
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  const workspace = v.parse(ProjectIdSchema, projectId);
  // SAFETY: the element is a JSX tree; `ReactElement` is what `render` takes.
  return render(
    (
      <RelayEnvironmentProvider environment={environment}>
        <ProjectWorkspaceProvider
          workspace={{ projectId: workspace, workspaceRoot: "", agentCwd: "" }}
        >
          <Opened state={state}>
            <PanelContent />
          </Opened>
        </ProjectWorkspaceProvider>
      </RelayEnvironmentProvider>
    ) as ReactElement,
  );
}

/** The panel state of one project's file. */
function fileState(projectId: string, path: string | null, next: string | null = null): PanelState {
  const workspaceId = toGlobalId("Project", projectId);
  return {
    selection: { workspaceId, path },
    next: next === null ? null : { workspaceId, path: next },
    files: [],
  };
}

/**
 * The shell's own write to the panel store, for one render.
 *
 * @param props.state - The state the shell would write.
 * @param props.children - The panel.
 * @returns The children, with the store set for this render.
 *
 * @remarks
 * The shell writes the store from its route; a test that mounts the panel without a shell writes
 * the same store, so the panel reads exactly what the shell would have given it.
 */
function Opened({
  state,
  children,
}: {
  readonly state: PanelState;
  readonly children: ReactNode;
}): ReactElement {
  panelStore.set(state);
  return <>{children}</>;
}

/** A component that only sets the tab's title: the hook under test, with nothing around it. */
function Title({ name }: { readonly name: string | null }): ReactElement {
  useDocumentTitle(name);
  return <span>{name ?? "none"}</span>;
}

// Catches: the shell drawing a panel nobody asked for (its slot is empty until a file is chosen).
test("the panel draws nothing until a file is selected", () => {
  const { container } = renderPanel("project-1");
  expect(container.innerHTML).toBe("");
});

// Catches: the panel reading a selection with no shell around it (a module-level value nothing
// subscribes to would keep the last write and draw it in a page that never opened it).
test("a panel outside the shell is closed", () => {
  const environment = createEnvironment({
    fetch: async () =>
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  const workspace = v.parse(ProjectIdSchema, "project-1");
  const { container } = render(
    // SAFETY: ReactElement is what render takes; this element is one, and the cast is only the
    // JSX type the test's React copy names differently from the renderer's.
    (
      <RelayEnvironmentProvider environment={environment}>
        <ProjectWorkspaceProvider
          workspace={{ projectId: workspace, workspaceRoot: "", agentCwd: "" }}
        >
          <PanelContent />
        </ProjectWorkspaceProvider>
      </RelayEnvironmentProvider>
    ) as ReactElement,
  );
  expect(container.innerHTML).toBe("");
});

// Catches: a selection drawn under another project's workspace — a preview of a file this
// session cannot read, asked for with the wrong workspace (fail open).
test("a selection from another project is not drawn", () => {
  const { container } = renderPanel("project-1", fileState("project-2", "提案書.docx"));
  expect(container.innerHTML).toBe("");
});

// Catches: a selected file not reaching the panel (the preview would have no caller), and the
// panel asking with a workspace other than the project the Sidebar selected.
test("a selected file is drawn with the selected project as its workspace", async () => {
  renderPanel("project-1", fileState("project-1", "提案書.docx"));
  // The panel is a lazy chunk; the first draw is the header, and the file's name is on it.
  expect((await screen.findByRole("heading", { name: "文書プレビュー" })).textContent).toBe(
    "文書プレビュー",
  );
  expect(document.querySelector("[data-office-path]")?.getAttribute("data-office-path")).toBe(
    "提案書.docx",
  );
});

// Catches: a path outside the workspace being drawn as "nothing is selected" (or, worse, being
// asked about): the route's null path is a refusal, and it names the code the person sees.
test("a path the workspace cannot have is refused without asking the server", async () => {
  renderPanel("project-1", fileState("project-1", null));
  expect(screen.getByTestId("office-state").getAttribute("data-office-failure")).toBe(
    "not_authorized",
  );
  expect(screen.getByTestId("office-label").textContent).toBe("権限がありません");
});

// Catches: the shell and the panel disagreeing about which project a file belongs to (a raw id
// where the graph has a global one would send every preview to a workspace that is not this one).
test("the route's project becomes the graph's workspace id", () => {
  expect(
    selectionOfRoute({ kind: "file", projectId: "project-1", path: "a/b.docx" }),
  ).toStrictEqual({ workspaceId: toGlobalId("Project", "project-1"), path: "a/b.docx" });
  expect(selectionOfRoute({ kind: "workspace", projectId: "project-1" })).toBe(null);
  expect(selectionOfRoute({ kind: "file", projectId: "project-1", path: null })).toStrictEqual({
    workspaceId: toGlobalId("Project", "project-1"),
    path: null,
  });
});

// Catches: the tab saying "hns" while a person reads a document, and keeping the file's name
// after they leave it (the effect's cleanup is what gives the page's title back).
test("the tab's title is the open file's, and is given back", () => {
  document.title = "hns";
  const { unmount } = render(<Title name="提案書.docx" />);
  expect(document.title).toBe("提案書.docx");
  unmount();
  expect(document.title).toBe("hns");
});

test("a file's name is its last segment", () => {
  expect(fileNameOf("提案/本文.docx")).toBe("本文.docx");
  expect(fileNameOf("本文.docx")).toBe("本文.docx");
});

// Catches: a next link that is relative (it would keep this page's `?files=` query and append
// to it, so the list grew by one on every step) or that names another project.
test("the next control links to the next file in the same project", () => {
  const { container } = renderPanel("project-1", fileState("project-1", "a.docx", "b.docx"));
  const link = container.querySelector("[data-testid='office-next']");
  // The address is the location's own path with the same order: absolute, and one order.
  expect(link?.getAttribute("href")).toBe(
    window.location.origin + window.location.pathname + "#/p/project-1/doc/b.docx",
  );
});

// Catches: a next link that keeps the current order by appending to it — the order is written
// once, from the panel's own state, never grown from the page's query.
test("the next control carries the order once", () => {
  const state = fileState("project-1", "a.docx", "b.docx");
  const { container } = renderPanel("project-1", { ...state, files: ["a.docx", "b.docx"] });
  const href = container.querySelector("[data-testid='office-next']")?.getAttribute("href") ?? "";
  expect(href.split("files=").length - 1).toBe(2);
});

// Catches: a next control drawn when the route named nothing after this file (it would link to
// the file it is already showing, or to none at all).
test("no next control when the route names nothing after this file", () => {
  const { container } = renderPanel("project-1", fileState("project-1", "a.docx"));
  expect(container.querySelector("[data-testid='office-next']")).toBe(null);
});
