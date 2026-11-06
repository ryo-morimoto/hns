import { EditorBuffer } from "/buffer.mjs";
import { diffHunks, diffLines } from "/diff.mjs";

const $ = (id) => document.querySelector(id);
const messagesEl = $("#messages"), liveEl = $("#live"), inputEl = $("#input");
const filesEl = $("#files"), textEl = $("#text"), diffEl = $("#diff"), pathEl = $("#path");
const statusEl = $("#status"), versionEl = $("#version"), conflictEl = $("#conflict");
let counter = 0, diffMode = false;

// Chat
async function refreshState() {
  const state = await (await fetch("/api/state")).json();
  messagesEl.replaceChildren(...state.messages.map((message) => {
    const div = document.createElement("div");
    div.className = "msg " + message.role + (message.text?.includes("isError") ? " error" : "");
    div.textContent = message.role === "tool"
      ? `[${message.toolName}] ${message.text}`
      : message.text || (message.toolCalls?.length ? `→ ${message.toolCalls.join(", ")}` : "");
    return div;
  }));
  messagesEl.scrollTop = messagesEl.scrollHeight;
  liveEl.textContent = state.live ? `running: ${state.live}` : "";
}

$("#compose").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = inputEl.value.trim();
  if (!message) return;
  inputEl.value = "";
  await fetch("/api/chat", { method: "POST", body: JSON.stringify({ message }) });
  refreshState();
});

// Editor
const read = async (path) => {
  const response = await fetch("/api/file?path=" + encodeURIComponent(path));
  if (!response.ok) throw new Error("read failed");
  return response.json();
};
const save = async (input) => (await fetch("/api/file", { method: "PUT", body: JSON.stringify(input) })).json();
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
  const files = await (await fetch("/api/files?path=.")).json();
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
await refreshState();
setInterval(refreshState, 1000);
