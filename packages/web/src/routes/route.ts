/** The hash routes the shell understands. Anything else normalizes to the workspace. */
export type Route =
  | { readonly kind: "workspace"; readonly projectId: string | null }
  | {
      readonly kind: "conversation";
      readonly projectId: string;
      readonly conversationId: string;
    }
  | {
      /** The workspace's policy: the active revision and the proposals waiting for a human. */
      readonly kind: "policy";
      readonly projectId: string;
    }
  | {
      /**
       * One Trail's review face (0232): its changes, findings, decisions, and gates.
       *
       * @remarks
       * The id is the store's (not a global id): the route is a hash a person can keep, and the
       * screen turns it into the global id the face takes.
       */
      readonly kind: "trail";
      readonly projectId: string;
      readonly trailId: string;
    }
  | {
      /**
       * One workspace file, open in the shell's document panel (0239).
       *
       * @remarks
       * The address of a preview a person can keep and share: `#/p/<project>/doc/<path>`. The
       * path is workspace-relative and kept whole — its `/` characters are the file's own
       * directory structure, not route separators — and `path` is null for a request that
       * named a file the workspace cannot have (a path climbing out of it, or an empty one).
       * A null path still names the project: the panel says the file cannot be opened rather
       * than the shell falling back to the workspace it did not ask for.
       *
       * This is the **entry that opens the panel**; the workspace's file list (0125 / 0104)
       * will link to the same addresses instead of inventing a second way in.
       */
      readonly kind: "file";
      readonly projectId: string;
      readonly path: string | null;
    };

const POLICY_SEGMENT = "policy";
/** The segment a Trail's review face is addressed by (`#/p/<project>/t/<trail>`). */
const TRAIL_SEGMENT = "t";
/** The segment a file opens under (`#/p/<project>/doc/<path>`). */
const DOC_SEGMENT = "doc";

export function parseHash(hash: string): Route {
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!path.startsWith("/")) return { kind: "workspace", projectId: null };
  const parts = path.split("/").filter((part) => part !== "");
  if (parts[0] !== "p") return { kind: "workspace", projectId: null };
  const projectId = decodePart(parts[1]);
  if (projectId === null) return { kind: "workspace", projectId: null };
  if (parts.length === 2) return { kind: "workspace", projectId };
  // Two segments name a workspace of the project itself; a malformed one is the workspace's.
  // The bare `doc` segment is the exception: it is a file address with no path, which the route
  // keeps as such so the panel can say the file cannot be opened instead of showing the workspace.
  if (parts.length === 3) {
    if (parts[2] === POLICY_SEGMENT) return { kind: "policy", projectId };
    if (parts[2] === DOC_SEGMENT) return { kind: "file", projectId, path: null };
    return { kind: "workspace", projectId };
  }
  const trailId = parts.length === 4 && parts[2] === TRAIL_SEGMENT ? decodePart(parts[3]) : null;
  if (trailId !== null) return { kind: "trail", projectId, trailId };
  if (parts[2] === DOC_SEGMENT) return { kind: "file", projectId, path: filePathOf(parts) };
  const conversationId = parts.length === 4 && parts[2] === "c" ? decodePart(parts[3]) : null;
  if (conversationId === null) return { kind: "workspace", projectId };
  return { kind: "conversation", projectId, conversationId };
}

export function formatHash(route: Route): string {
  if (route.kind === "conversation") {
    return `#/p/${encodeURIComponent(route.projectId)}/c/${encodeURIComponent(route.conversationId)}`;
  }
  if (route.kind === "policy") {
    return `#/p/${encodeURIComponent(route.projectId)}/${POLICY_SEGMENT}`;
  }
  if (route.kind === "trail") {
    return `#/p/${encodeURIComponent(route.projectId)}/${TRAIL_SEGMENT}/${encodeURIComponent(route.trailId)}`;
  }
  if (route.kind === "file") {
    const base = `#/p/${encodeURIComponent(route.projectId)}/${DOC_SEGMENT}`;
    // A file with no path is the route's own "cannot be opened": the segment stays, empty.
    return route.path === null ? base + "/" : base + "/" + encodeFile(route.path);
  }
  if (route.projectId === null) return "#/";
  return `#/p/${encodeURIComponent(route.projectId)}`;
}

/**
 * The file one `doc` route names, or null when it names none the workspace can have.
 *
 * @param parts - The route's segments: `p`, the project, `doc`, and the path's own segments.
 * @returns The workspace-relative path, or null.
 *
 * @remarks
 * **The path keeps its slashes.** A route's segments are split on `/`, but a workspace path
 * may hold directories (`提案/本文.docx`); the part after `doc` is rejoined as it was written and
 * each segment is decoded once, so `%2F` inside a segment stays a literal slash in a name
 * rather than becoming a separator.
 *
 * **A path that could climb out is not a file.** The empty path, an absolute one, and any
 * segment of `.` or `..` are refused here, as the contract's workspace paths are (a read of
 * one is a refusal on the other side, and the route should not hand it one). A refused path is
 * null, which the panel draws as "cannot be opened" — never as another file.
 */
function filePathOf(parts: readonly string[]): string | null {
  const raw = parts.slice(3).join("/");
  if (raw === "") return null;
  // A segment is decoded once and then checked: `%2E%2E` is the same `..` a browser would send
  // after decoding, and it is refused for the same reason.
  const segments: string[] = [];
  for (const part of raw.split("/")) {
    const segment = decodePart(part);
    if (segment === null || segment === "." || segment === "..") return null;
    // A decoded segment may itself hold slashes (`%2F`); each one is a name's own character
    // there, but a path that became absolute or climbed is still not a file of the workspace.
    if (segment.split("/").some((piece) => piece === "" || piece === "." || piece === "..")) {
      return null;
    }
    segments.push(segment);
  }
  const path = segments.join("/");
  return path.startsWith("/") ? null : path;
}

/**
 * A workspace path as the route carries it: one segment per `/`, each encoded on its own.
 *
 * @param path - The workspace-relative path.
 * @returns The path's segments, encoded and joined.
 */
function encodeFile(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function decodePart(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed percent escape is not a route; fall back to the workspace.
    return null;
  }
}
