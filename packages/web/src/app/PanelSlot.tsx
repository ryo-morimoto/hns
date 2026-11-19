import { toGlobalId } from "@hns/core/graphql";
import { lazy, Suspense, useSyncExternalStore, type ReactElement } from "react";
import type { PanelState } from "./PanelState.ts";
import { useProjectWorkspace } from "./ProjectWorkspace.tsx";

/**
 * The document panel, loaded when a file is selected.
 *
 * @remarks
 * The panel is the shell's right slot, and most visits never open a file: the screen that draws
 * documents (and the reader it opens them with) is a chunk of its own, loaded on the first
 * selection. `DocumentPanel` holds no state a visit needs before then.
 */
/**
 * Modules the panel's chunk needs, loaded once.
 *
 * @remarks
 * The document panel is a lazy chunk, and Vite's build runs the lazily imported modules' side
 * effects when the import resolves. The reader (PDF.js) and the panel's own request module are
 * loaded here, ahead of the chunk, so the state the panel draws does not depend on when those
 * side effects ran: `DocumentPanel`'s import is the one the shell's Suspense waits for.
 */
const preload = Promise.all([
  import("../office/PdfViewer.tsx"),
  import("../office/Request.tsx"),
]).catch(() => undefined);

/**
 * A store that tells React when it changes.
 *
 * @returns The store: a snapshot and the subscribers.
 *
 * @remarks
 * The panel's state is a value, and the panel must redraw when it changes. `useSyncExternalStore`
 * is React's own way to read a value that lives outside the component; the shell writes it when
 * its route changes, and every mounted panel reads it.
 */
function createPanelStore() {
  let state: PanelState = { selection: null, next: null, files: [] };
  const listeners = new Set<() => void>();
  return {
    get: (): PanelState => state,
    set: (next: PanelState): void => {
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The shell's panel state, written by the shell and read by every mounted panel. */
export const panelStore = createPanelStore();

const DocumentPanel = lazy(async () => {
  await preload;
  const loaded = await import("../office/DocumentPanel.tsx");
  return { default: loaded.DocumentPanel };
});

/**
 * The shell's right panel: the document preview, when the route names a file.
 *
 * @returns The panel, or null (the shell keeps its closed panel).
 *
 * @remarks
 * **A preview needs a workspace.** A file named without one is `not_authorized` (fail closed), so
 * the workspace is the shell's selected project, not the file's path: a selection made in another
 * project is not drawn here. The selection itself is the route's (the shell provides it through
 * `PanelProvider`, in `PanelContent.ts`), so the URL and the panel cannot disagree about which
 * file is open.
 */
/**
 * The next file, when the route named one: a selection with no path is not a file to open.
 *
 * @param next - The shell's next selection.
 * @returns The next file's path, or null.
 */
function nextOf(next: { readonly path: string | null } | null): { readonly path: string } | null {
  return next === null || next.path === null ? null : { path: next.path };
}

export function PanelContent(): ReactElement | null {
  const workspace = useProjectWorkspace();
  const panel = useSyncExternalStore(panelStore.subscribe, panelStore.get, panelStore.get);
  const selection = panel.selection;
  if (workspace === null || selection === null) return null;
  if (selection.workspaceId !== toGlobalId("Project", workspace.projectId)) return null;
  return (
    <Suspense fallback={null}>
      <DocumentPanel
        workspaceId={selection.workspaceId}
        path={selection.path}
        next={nextOf(panel.next)}
        files={panel.files}
      />
    </Suspense>
  );
}
