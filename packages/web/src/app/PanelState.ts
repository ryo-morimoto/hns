import { toGlobalId } from "@hns/core/graphql";
import { useEffect } from "react";

/**
 * The file the shell's document panel is open on, as the URL names it.
 *
 * @remarks
 * The shell keeps one of these, and nothing else in the build needs two. The shell hands it to
 * the panel through {@link PanelProvider}, and it is the route's: `#/p/<project>/doc/<path>` is
 * the one way to open a file (a screen that arrives later links to that hash rather than
 * keeping a second copy of which file is open).
 */
export interface PreviewSelection {
  /** The project the file is in, as the graph names it (`Project` global id). */
  readonly workspaceId: string;
  /** The workspace-relative path, or null for a request the route could not read as a file. */
  readonly path: string | null;
}

/**
 * What the shell offers the panel: the file to open, and the file after this one.
 *
 * @remarks
 * **The selection is a value, not a module variable.** The panel is a child of the shell and
 * must redraw when the file changes; a module-level cell with no subscription (what the first
 * build had) could be written by anything and read by nobody. When there is a shell the panel
 * reads this; a panel rendered outside one closes itself.
 */
export interface PanelState {
  readonly selection: PreviewSelection | null;
  /** The file after this one in the URL's order, for the panel's "next" control; null at the end. */
  readonly next: PreviewSelection | null;
}

/**
 * The selection one route names, for the shell's panel.
 *
 * @param route - The current route.
 * @returns The project and the file, or null when the route names no file.
 *
 * @remarks
 * The route is the one place a selection comes from: the URL hash names the project and the
 * path, and the shell turns it into the graph's ids here. A `file` route whose path is null
 * is still a selection: the panel says the file cannot be opened, and the shell does not fall
 * back to whatever was open before.
 */
export function selectionOfRoute(route: {
  readonly kind: string;
  readonly projectId?: string | null;
  readonly path?: string | null;
}): PreviewSelection | null {
  if (route.kind !== "file" || route.projectId === null || route.projectId === undefined) {
    return null;
  }
  return {
    workspaceId: toGlobalId("Project", route.projectId),
    path: route.path === undefined ? null : route.path,
  };
}

/**
 * Set `document.title` to the open file, and put it back when the visit ends.
 *
 * @param title - The title to set, or null to leave the page's title alone.
 *
 * @remarks
 * A document opened from a hash is a new page to a person's history and to a browser's tab;
 * the tab should say which file it is. Restoring the previous title on the way out keeps the
 * workspace's own title truthful.
 */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (title === null) return undefined;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/**
 * A file's name without its directory.
 *
 * @param path - The workspace-relative path.
 * @returns The last segment: what a tab or a header shows first.
 */
export function fileNameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}
