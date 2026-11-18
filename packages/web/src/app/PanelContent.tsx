import { useEffect, type ReactElement } from "react";
import { toGlobalId } from "@hns/core/graphql";
import { DocumentPanel } from "../office/DocumentPanel.tsx";
import { useProjectWorkspace } from "./ProjectWorkspace.tsx";

/**
 * The file the document panel was last asked to open.
 *
 * @remarks
 * A **module-level** value rather than a React state, because nothing in this build can set one
 * yet: the workspace's file list has no preview action, and the conversation does not carry a
 * file. Until a screen exists that opens a file, the panel is closed and the shell draws what it
 * drew before — but the panel itself is complete and is what that screen will mount.
 *
 * It is a module value rather than a prop chain so the one screen that arrives first can set it
 * without the shell owning a second piece of UI state.
 */
export interface PreviewSelection {
  /** The project the file is in, as the graph names it (`Project` global id). */
  readonly workspaceId: string;
  /** The workspace-relative path. */
  readonly path: string;
}

let current: PreviewSelection | null = null;

/**
 * Ask the shell's right panel to show one file's preview.
 *
 * @param selection - The project and the path, or null to close the panel.
 * @returns What changed, for a caller that re-renders the shell.
 *
 * @remarks
 * The panel is bound to the workspace the Sidebar selected: a selection for another project is
 * not drawn, and closing the selection is how a screen gives the panel back.
 */
export function setPreviewSelection(selection: PreviewSelection | null): PreviewSelection | null {
  current = selection;
  return current;
}

/** Read what the panel is asked to show. */
export function previewSelection(): PreviewSelection | null {
  return current;
}

/**
 * The shell's right panel: the document preview, when a screen has asked for one.
 *
 * @returns The panel, or null (the shell keeps its closed panel).
 *
 * @remarks
 * **A preview needs a workspace.** A file named without one is `not_authorized` (fail closed), so
 * the workspace is the shell's selected project, not the file's path: a selection made in another
 * project is not drawn here.
 */
export function PanelContent(): ReactElement | null {
  const workspace = useProjectWorkspace();
  const selection = previewSelection();
  useEffect(() => {
    // Nothing to do yet: the panel is drawn from the module's value, and the screen that sets it
    // re-renders the shell. The effect exists so the value is read on every render, after mount.
  });
  if (workspace === null || selection === null) return null;
  if (selection.workspaceId !== toGlobalId("Project", workspace.projectId)) return null;
  return <DocumentPanel workspaceId={selection.workspaceId} path={selection.path} />;
}
