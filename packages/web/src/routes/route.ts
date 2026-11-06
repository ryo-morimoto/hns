/** The hash routes the shell understands. Anything else normalizes to the workspace. */
export type Route =
  | { readonly kind: "workspace"; readonly projectId: string | null }
  | {
      readonly kind: "conversation";
      readonly projectId: string;
      readonly conversationId: string;
    };

export function parseHash(hash: string): Route {
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!path.startsWith("/")) return { kind: "workspace", projectId: null };
  const parts = path.split("/").filter((part) => part !== "");
  if (parts[0] !== "p") return { kind: "workspace", projectId: null };
  const projectId = decodePart(parts[1]);
  if (projectId === null) return { kind: "workspace", projectId: null };
  if (parts.length === 2) return { kind: "workspace", projectId };
  const conversationId = parts.length === 4 && parts[2] === "c" ? decodePart(parts[3]) : null;
  if (conversationId === null) return { kind: "workspace", projectId };
  return { kind: "conversation", projectId, conversationId };
}

export function formatHash(route: Route): string {
  if (route.kind === "conversation") {
    return `#/p/${encodeURIComponent(route.projectId)}/c/${encodeURIComponent(route.conversationId)}`;
  }
  if (route.projectId === null) return "#/";
  return `#/p/${encodeURIComponent(route.projectId)}`;
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
