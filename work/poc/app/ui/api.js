// The PoC's typed-ish HTTP client. One place for the token, errors, and JSON.
// The product client is 0037; this file is deliberately small and disposable.

const TOKEN_KEY = "hns_token";

export class ApiError extends Error {
  constructor(status, message, payload) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

/** Read ?token= once, keep it out of the address bar, and fall back to sessionStorage. */
export function readToken() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete("token");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? "";
}

export const token = readToken();

export function withToken(path) {
  if (!token) return path;
  return path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
}

const enc = encodeURIComponent;

async function request(path, { method = "GET", body, signal } = {}) {
  const options = { method, signal };
  if (body !== undefined) {
    options.headers = { "content-type": "application/json" };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(withToken(path), options);
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }
  if (!response.ok) {
    throw new ApiError(response.status, payload?.error ?? response.statusText, payload);
  }
  return payload;
}

/** PUT /api/file answers 409/202 with an outcome body; the editor reads it instead of catching. */
async function writeFile(input) {
  const response = await fetch(withToken("/api/file"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (response.status === 401) throw new ApiError(401, payload?.error ?? "unauthorized", payload);
  if (!response.ok && response.status !== 409 && response.status !== 202 && response.status !== 200) {
    throw new ApiError(response.status, payload?.error ?? response.statusText, payload);
  }
  return payload;
}

export const api = {
  state: (conversationId) =>
    request("/api/state" + (conversationId ? "?conversationId=" + enc(conversationId) : "")),

  projects: () => request("/api/projects"),
  createProject: (name) => request("/api/projects", { method: "POST", body: { name } }),
  updateProject: (id, patch) => request("/api/projects/" + enc(id), { method: "PATCH", body: patch }),

  conversations: ({ projectId, q, includeArchived = false } = {}) => {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (q) params.set("q", q);
    if (includeArchived) params.set("includeArchived", "1");
    const query = params.toString();
    return request("/api/conversations" + (query ? "?" + query : ""));
  },
  createConversation: ({ projectId, title = "新しい会話" } = {}) =>
    request("/api/conversations", { method: "POST", body: { projectId, title } }),
  updateConversation: (id, patch) =>
    request("/api/conversations/" + enc(id), { method: "PATCH", body: patch }),
  deleteConversation: (id) =>
    request("/api/conversations/" + enc(id), { method: "DELETE" }),

  tasks: (projectId) =>
    request("/api/tasks" + (projectId ? "?projectId=" + enc(projectId) : "")),
  createTask: (projectId, title) =>
    request("/api/tasks", { method: "POST", body: { projectId, title } }),
  updateTask: (id, patch) =>
    request("/api/tasks/" + enc(id), { method: "PATCH", body: patch }),

  chat: (message, conversationId) =>
    request("/api/chat", { method: "POST", body: { message, conversationId } }),
  abort: (conversationId) =>
    request("/api/chat/abort", { method: "POST", body: { conversationId } }),

  files: (path = ".") => request("/api/files?path=" + enc(path)),
  readFile: (path) => request("/api/file?path=" + enc(path)),
  writeFile,

  usage: () => request("/api/usage"),
  health: () => request("/api/health"),
  metrics: () => request("/api/metrics"),
  events: (limit = 50) => request("/api/events?limit=" + enc(String(limit))),

  workflows: (projectId) =>
    request("/api/workflows" + (projectId ? "?projectId=" + enc(projectId) : "")),
  runs: (workflowId) =>
    request("/api/runs" + (workflowId ? "?workflowId=" + enc(workflowId) : "")),
  run: (id) => request("/api/runs/" + enc(id)),
  startRun: (workflowId, input = "") =>
    request("/api/workflows/" + enc(workflowId) + "/runs", { method: "POST", body: { input } }),
  completeNode: (runId, nodeId, output) =>
    request("/api/runs/" + enc(runId) + "/nodes/" + enc(nodeId), { method: "POST", body: { output } }),

  automations: (projectId) =>
    request("/api/automations" + (projectId ? "?projectId=" + enc(projectId) : "")),
  firings: (automationId) =>
    request("/api/automations/" + enc(automationId) + "/firings"),
};
