import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { RelayEnvironmentProvider } from "react-relay";
import { expect, test } from "vitest";
import { toGlobalId } from "@hns/core/graphql";
import { ProjectIdSchema } from "@hns/core";
import * as v from "valibot";
import { createEnvironment } from "../relay/environment.ts";
import { PanelContent, previewSelection, setPreviewSelection } from "./PanelContent.tsx";
import { ProjectWorkspaceProvider } from "./ProjectWorkspace.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/**
 * The shell's right panel, as the shell mounts it.
 *
 * @remarks
 * The panel is the one place the document preview is mounted; what these tests fix is **who
 * mounts it and with which workspace**: the Sidebar's selected project (the one context fact the
 * panel is given) and the file a screen selected. A preview drawn for another project would be
 * a read this session has no business making, and the panel refuses to draw one.
 */
function renderPanel(projectId: string): ReturnType<typeof render> {
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
          <PanelContent />
        </ProjectWorkspaceProvider>
      </RelayEnvironmentProvider>
    ) as ReactElement,
  );
}

// Catches: the shell drawing a panel nobody asked for (its slot is empty until a file is chosen).
test("the panel draws nothing until a file is selected", () => {
  setPreviewSelection(null);
  const { container } = renderPanel("project-1");
  expect(previewSelection()).toBe(null);
  expect(container.innerHTML).toBe("");
});

// Catches: a selection drawn under another project's workspace — a preview of a file this
// session cannot read, asked for with the wrong workspace (fail open).
test("a selection from another project is not drawn", () => {
  const other = "project-2";
  setPreviewSelection({ workspaceId: toGlobalId("Project", other), path: "提案書.docx" });
  const { container } = renderPanel("project-1");
  expect(container.innerHTML).toBe("");
});

// Catches: a selected file not reaching the panel (the preview would have no caller), and the
// panel asking with a workspace other than the project the Sidebar selected.
test("a selected file is drawn with the selected project as its workspace", async () => {
  const projectId = "project-1";
  setPreviewSelection({ workspaceId: toGlobalId("Project", projectId), path: "提案書.docx" });
  try {
    renderPanel(projectId);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "文書プレビュー" })).toBeTruthy(),
    );
    expect(document.querySelector("[data-office-path]")?.getAttribute("data-office-path")).toBe(
      "提案書.docx",
    );
  } finally {
    setPreviewSelection(null);
  }
});
