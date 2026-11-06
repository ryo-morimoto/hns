import { EditorBuffer } from "/buffer.mjs";
import { diffLines } from "/diff.mjs";

const filesEl = document.querySelector("#files");
const textEl = document.querySelector("#text");
const pathEl = document.querySelector("#path");
const statusEl = document.querySelector("#status");
const versionEl = document.querySelector("#version");
const conflictEl = document.querySelector("#conflict");
const diffEl = document.querySelector("#diff");
let diffMode = false;

let counter = 0;
const read = async (path) => {
  const response = await fetch("/read?path=" + encodeURIComponent(path));
  if (!response.ok) throw new Error("read failed");
  return response.json();
};
const save = async (input) => {
  const response = await fetch("/write", { method: "POST", body: JSON.stringify(input) });
  return response.json();
};
const buffer = new EditorBuffer({ read, save });

function showDiff(before, after, label) {
  const result = diffLines(before, after);
  diffEl.replaceChildren();
  if (result.tooLarge) {
    diffEl.textContent = "差分が大きすぎます。";
    return;
  }
  for (const op of result.ops) {
    const line = document.createElement("div");
    line.className = op.type;
    line.textContent = (op.type === "add" ? "+" : op.type === "del" ? "-" : " ") + op.text;
    diffEl.append(line);
  }
}

function render() {
  pathEl.textContent = buffer.path ?? "(no file)";
  versionEl.textContent = buffer.baseVersion;
  textEl.value = buffer.content;
  if (diffMode) {
    textEl.hidden = true;
    diffEl.hidden = false;
    showDiff(buffer.conflict?.external?.content ?? buffer.savedContent, buffer.content);
  } else {
    textEl.hidden = false;
    diffEl.hidden = true;
  }
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
}

async function openFile(path) {
  await buffer.open(path);
  render();
}

async function refresh() {
  const list = await (await fetch("/list?path=.")).json();
  filesEl.replaceChildren(...list.map((entry) => {
    const button = document.createElement("button");
    button.textContent = entry.path;
    button.onclick = () => openFile(entry.path);
    return button;
  }));
}

textEl.addEventListener("input", () => { buffer.edit(textEl.value); render(); });
document.querySelector("#save").onclick = () => buffer.save("ui-" + ++counter).then(render);
document.querySelector("#diff").onclick = () => { diffMode = !diffMode; render(); };
document.querySelector("#reload").onclick = () => buffer.reload().then(render);

await refresh();