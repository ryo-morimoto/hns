import { EditorBuffer } from "/buffer.mjs";
import { diffHunks, diffLines } from "/diff.mjs";

const $ = (id) => document.querySelector(id);
const params = new URLSearchParams(location.search);
if (params.get("token")) sessionStorage.setItem("hns_token", params.get("token"));
const token = sessionStorage.getItem("hns_token");
const withToken = (url) => url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token ?? "");
const apiFetch = async (url, options) => {
  const response = await fetch(withToken(url), options);
  if (response.status === 401 && !token && !location.pathname.endsWith("/login.html")) location.href = "/login.html";
  return response;
};
const messagesEl = $("#messages"), liveEl = $("#live"), inputEl = $("#input"), tasksEl = $("#tasks");
let lastMessageCount = -1;
const filesEl = $("#files"), textEl = $("#text"), diffEl = $("#diff"), pathEl = $("#path");
const statusEl = $("#status"), versionEl = $("#version"), conflictEl = $("#conflict");
let counter = 0, diffMode = false;

// Chat: one SSE stream carries the transcript and the unfinished tasks.
function renderState(state) {
  messagesEl.replaceChildren(...state.messages.map((message) => {
    const div = document.createElement("div");
    div.className = "msg " + message.role + (message.text?.includes("isError") ? " error" : "");
    div.textContent = message.role === "tool"
      ? `[${message.toolName}] ${message.text}`
      : message.text || (message.toolCalls?.length ? `→ ${message.toolCalls.join(", ")}` : "");
    return div;
  }));
  messagesEl.scrollTop = messagesEl.scrollHeight;
  tasksEl.replaceChildren(...state.tasks.map((task) => {
    const div = document.createElement("div");
    div.className = "task";
    div.textContent = `${task.kind} — ${task.state} (#${task.id})`;
    return div;
  }));
  liveEl.textContent = state.tasks.length ? `tasks: ${state.tasks.length}` : "";
  if (state.messages.length !== lastMessageCount) {
    lastMessageCount = state.messages.length;
    refreshFiles();
  }
}

const stream = new EventSource(withToken("/api/stream"));
stream.addEventListener("state", (event) => renderState(JSON.parse(event.data)));

$("#compose").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = inputEl.value.trim();
  if (!message) return;
  inputEl.value = "";
  await apiFetch("/api/chat", { method: "POST", body: JSON.stringify({ message }) });
});

// Editor
const read = async (path) => {
  const response = await apiFetch("/api/file?path=" + encodeURIComponent(path));
  if (!response.ok) throw new Error("read failed");
  return response.json();
};
const save = async (input) => (await apiFetch("/api/file", { method: "PUT", body: JSON.stringify(input) })).json();
const buffer = new EditorBuffer({ read, save });

function showDiff(before, after) {
  const { hunks } = diffHunks(diffLines(before, after).ops);
  diffEl.replaceChildren();
  if (hunks.length === 0) { diffEl.textContent = "変更はありません。"; return; }
  for (const part of hunks) {
    if (part.type === "skip") {
      const skip = document.createElement("div");
      skip.className = "same";
      skip.textContent = `… ${part.count} 行`;
      diffEl.append(skip);
      continue;
    }
    for (const op of part.ops) {
      const line = document.createElement("div");
      line.className = op.type;
      line.textContent = (op.type === "add" ? "+" : op.type === "del" ? "-" : " ") + op.text;
      diffEl.append(line);
    }
  }
}

function render() {
  pathEl.textContent = buffer.path ?? "(no file)";
  versionEl.textContent = buffer.baseVersion;
  textEl.value = buffer.content;
  statusEl.textContent = buffer.dirty ? "dirty" : "";
  statusEl.className = buffer.dirty ? "dirty" : "";
  conflictEl.hidden = buffer.conflict === null;
  if (buffer.conflict !== null) {
    conflictEl.textContent = "このファイルは外で変更されました。";
    const reload = document.createElement("button");
    reload.textContent = "Reload";
    reload.onclick = () => buffer.reload().then(render);
    const overwrite = document.createElement("button");
    overwrite.textContent = "Overwrite";
    overwrite.onclick = () => buffer.overwrite("ui-" + ++counter).then(render);
    conflictEl.append(reload, overwrite);
  }
  if (diffMode) {
    textEl.hidden = true; diffEl.hidden = false;
    showDiff(buffer.conflict?.external?.content ?? buffer.savedContent, buffer.content);
  } else {
    textEl.hidden = false; diffEl.hidden = true;
  }
}

async function openFile(path) { await buffer.open(path); render(); }

async function refreshFiles() {
  const files = await (await apiFetch("/api/files?path=.")).json();
  filesEl.replaceChildren(...files.filter((entry) => entry.kind === "file").slice(0, 200).map((entry) => {
    const button = document.createElement("button");
    button.textContent = entry.path;
    button.onclick = () => openFile(entry.path);
    return button;
  }));
}

textEl.addEventListener("input", () => { buffer.edit(textEl.value); render(); });
$("#save").onclick = () => buffer.save("ui-" + ++counter).then(render);
$("#reload").onclick = () => buffer.reload().then(render);
$("#diffToggle").onclick = () => { diffMode = !diffMode; render(); };

await refreshFiles();