// The right-hand context panel: files, a small text editor, and the diff.
// It reuses the proven EditorBuffer and diff modules; the panel only adds chrome.

import { EditorBuffer } from "/buffer.mjs";
import { diffHunks, diffLines } from "/diff.mjs";
import { h, icon, toast, confirmAction } from "./ui.js";

const operationId = () =>
  "ui-" + (globalThis.crypto?.randomUUID?.() ?? Date.now() + "-" + Math.random().toString(16).slice(2));

export class EditorPanel {
  constructor({ root, api, onDirtyChange = () => {}, onOpenFile = () => {}, onClose = () => {} }) {
    this.root = root;
    this.api = api;
    this.onDirtyChange = onDirtyChange;
    this.onOpenFile = onOpenFile;
    this.onClose = onClose;
    this.buffer = null;
    this.files = [];
    this.filter = "";
    this.diffMode = false;
    this.visible = false;
    this.loading = false;
    this.filesLoading = false;
    this.saving = false;
    this.error = null;
    this.filesError = null;
    this.path = null;
    this.loadToken = 0;
    this.lastPath = localStorage.getItem("hns.editor.lastPath") || null;
    this.mount();
  }

  mount() {
    this.root.classList.add("editor-panel");
    this.root.hidden = true;

    this.pathEl = h("span", { class: "editor-path-text", text: "ファイル未選択" });
    this.versionEl = h("span", { class: "version-badge", hidden: true });
    this.dirtyEl = h("span", { class: "editor-dirty", hidden: true, title: "未保存の変更" });
    this.saveBtn = h("button", { class: "btn btn-primary btn-sm", type: "button", onclick: () => this.save() }, "保存");
    this.reloadBtn = h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => this.reload() }, "再読込");
    this.diffBtn = h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => this.toggleDiff(), title: "差分を表示" }, icon("diff", 14), h("span", { text: "差分" }));

    const head = h("header", { class: "editor-head" },
      h("div", { class: "editor-head-main" },
        h("button", { class: "icon-btn editor-close", type: "button", "aria-label": "エディタを閉じる", title: "閉じる", onclick: () => this.onClose() }, icon("chevronLeft", 16)),
        h("span", { class: "editor-path-icon" }, icon("file", 14)),
        this.pathEl,
        this.versionEl,
        this.dirtyEl,
      ),
      h("div", { class: "editor-actions" }, this.saveBtn, this.reloadBtn, this.diffBtn,
        h("button", { class: "icon-btn editor-close-x", type: "button", "aria-label": "エディタを閉じる", title: "閉じる", onclick: () => this.onClose() }, icon("close", 14)),
      ),
    );

    this.conflictEl = h("div", { class: "editor-conflict", hidden: true });
    this.filterInput = h("input", {
      class: "file-filter-input",
      type: "search",
      placeholder: "ファイルを絞り込む",
      "aria-label": "ファイルを絞り込む",
      oninput: (event) => { this.filter = event.target.value; this.renderFiles(); },
    });
    this.fileListEl = h("div", { class: "file-list", role: "listbox", "aria-label": "ファイル" });
    this.gutterEl = h("pre", { class: "editor-gutter", "aria-hidden": "true" });
    this.textEl = h("textarea", {
      class: "editor-text",
      spellcheck: "false",
      wrap: "off",
      "aria-label": "ファイルの内容",
      oninput: () => this.onInput(),
      onkeydown: (event) => this.onKeyDown(event),
      onscroll: () => { this.gutterEl.scrollTop = this.textEl.scrollTop; },
    });
    this.diffEl = h("div", { class: "editor-diff", hidden: true });
    this.emptyEl = h("div", { class: "editor-empty" });
    this.loadingEl = h("div", { class: "editor-loading", hidden: true },
      h("div", { class: "skeleton skeleton-line w-70" }),
      h("div", { class: "skeleton skeleton-line w-90" }),
      h("div", { class: "skeleton skeleton-line w-50" }),
    );

    this.textWrap = h("div", { class: "editor-text-wrap" }, this.gutterEl, this.textEl);
    const body = h("div", { class: "editor-body" },
      h("aside", { class: "file-pane", "aria-label": "ファイル" },
        h("div", { class: "file-filter" }, icon("search", 13), this.filterInput),
        this.fileListEl,
      ),
      h("div", { class: "editor-main" },
        this.textWrap,
        this.diffEl,
        this.emptyEl,
        this.loadingEl,
      ),
    );

    this.root.replaceChildren(head, this.conflictEl, body);
    this.render();
  }

  setVisible(visible) {
    this.visible = visible;
    this.root.hidden = !visible;
    this.root.classList.toggle("open", visible);
    if (visible) {
      this.render();
      if (this.files.length === 0 && !this.filesLoading) void this.loadFiles();
    }
  }

  isDirty() {
    return Boolean(this.buffer && (this.buffer.dirty || this.buffer.conflict));
  }

  /** Drop the in-memory edits after the discard prompt was accepted. */
  discard() {
    this.loadToken++;
    this.buffer = null;
    this.path = null;
    this.diffMode = false;
    this.error = null;
    this.textEl.value = "";
    this.updateGutter();
    this.render();
    this.onDirtyChange();
  }

  async confirmDiscard() {
    if (!this.isDirty()) return true;
    return confirmAction({
      title: "未保存の変更があります",
      description: "変更を破棄して移動しますか？保存する場合はキャンセルしてください。",
      confirmLabel: "破棄して移動",
      danger: true,
    });
  }

  async setPath(path) {
    const next = path || null;
    if (next === this.path && (next === null || this.buffer)) return;
    this.path = next;
    if (next) {
      this.lastPath = next;
      localStorage.setItem("hns.editor.lastPath", next);
      await this.open(next);
    } else {
      this.buffer = null;
      this.error = null;
      this.loading = false;
      this.render();
      this.onDirtyChange();
    }
  }

  async open(path) {
    const token = ++this.loadToken;
    this.path = path;
    this.loading = true;
    this.error = null;
    this.diffMode = false;
    this.render();
    try {
      const buffer = new EditorBuffer({
        read: (target) => this.api.readFile(target),
        save: (input) => this.api.writeFile(input),
      });
      await buffer.open(path);
      if (token !== this.loadToken) return;
      this.buffer = buffer;
      this.textEl.value = buffer.content;
      this.textEl.scrollTop = 0;
      this.gutterEl.scrollTop = 0;
      this.updateGutter();
    } catch {
      if (token !== this.loadToken) return;
      this.buffer = null;
      this.error = "「" + path + "」を開けませんでした。存在するか、テキストファイルか確認してください。";
    } finally {
      if (token === this.loadToken) {
        this.loading = false;
        this.render();
        this.onDirtyChange();
      }
    }
  }

  async reload() {
    if (!this.buffer) return;
    if (this.buffer.dirty) {
      const ok = await confirmAction({
        title: "変更を破棄しますか？",
        description: "ワークスペースの内容で置き換えます。",
        confirmLabel: "破棄して再読込",
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await this.buffer.reload();
      this.textEl.value = this.buffer.content;
      this.updateGutter();
      this.render();
      this.onDirtyChange();
    } catch (error) {
      toast("再読込に失敗しました: " + (error?.message ?? error), { kind: "error" });
    }
  }

  async save() {
    if (!this.buffer || !this.buffer.dirty || this.saving) return;
    this.saving = true;
    this.render();
    try {
      const outcome = await this.buffer.save(operationId());
      if (outcome.status === "applied") {
        toast("保存しました", { kind: "success", duration: 2200 });
      } else if (outcome.status === "conflict") {
        toast("外部で変更されていました。差分を確認してください。", { kind: "warn" });
      } else if (outcome.status === "unknown") {
        toast("保存結果を確認できません。再読込して確認してください。", { kind: "error" });
      }
    } catch (error) {
      toast("保存できませんでした: " + (error?.message ?? error), { kind: "error" });
    } finally {
      this.saving = false;
      this.render();
      this.onDirtyChange();
    }
  }

  async overwrite() {
    if (!this.buffer?.conflict) return;
    try {
      const outcome = await this.buffer.overwrite(operationId());
      if (outcome.status === "applied") {
        this.textEl.value = this.buffer.content;
        this.updateGutter();
        toast("上書きしました", { kind: "success" });
      } else if (outcome.status === "conflict") {
        toast("また外部で変更されました。再読込してください。", { kind: "warn" });
      }
    } catch (error) {
      toast("上書きできませんでした: " + (error?.message ?? error), { kind: "error" });
    }
    this.render();
    this.onDirtyChange();
  }

  toggleDiff() {
    if (!this.buffer) return;
    this.diffMode = !this.diffMode;
    this.render();
  }

  onInput() {
    if (!this.buffer) return;
    this.buffer.edit(this.textEl.value);
    this.updateGutter();
    this.syncDirty();
    this.onDirtyChange();
  }

  onKeyDown(event) {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void this.save();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const start = this.textEl.selectionStart;
      const end = this.textEl.selectionEnd;
      if (event.shiftKey) {
        const lineStart = this.textEl.value.lastIndexOf("\n", start - 1) + 1;
        const before = this.textEl.value.slice(lineStart, start);
        const remove = before.endsWith("  ") ? 2 : before.endsWith(" ") ? 1 : 0;
        if (remove > 0) {
          this.textEl.setRangeText("", start - remove, start, "end");
          this.onInput();
        }
      } else {
        this.textEl.setRangeText("  ", start, end, "end");
        this.onInput();
      }
    }
  }

  updateGutter() {
    const count = (this.textEl.value.match(/\n/g)?.length ?? 0) + 1;
    if (count <= 1) {
      this.gutterEl.textContent = "1";
    } else {
      this.gutterEl.textContent = Array.from({ length: count }, (_, index) => index + 1).join("\n");
    }
    this.gutterEl.scrollTop = this.textEl.scrollTop;
  }

  syncDirty() {
    const dirty = Boolean(this.buffer?.dirty);
    this.dirtyEl.hidden = !dirty;
    this.saveBtn.disabled = !dirty || this.saving;
    this.textEl.classList.toggle("is-dirty", dirty);
  }

  async loadFiles() {
    if (this.filesLoading) return;
    this.filesLoading = true;
    this.filesError = null;
    this.renderFiles();
    try {
      const listing = await this.api.files(".");
      this.files = listing
        .filter((entry) => entry.kind === "file")
        .map((entry) => entry.path)
        .sort((left, right) => left.localeCompare(right));
    } catch {
      this.filesError = "ファイル一覧を取得できませんでした";
    } finally {
      this.filesLoading = false;
      this.renderFiles();
    }
  }

  refreshFilesSoon() {
    if (!this.visible) return;
    clearTimeout(this.filesTimer);
    this.filesTimer = setTimeout(() => void this.loadFiles(), 400);
  }

  renderFiles() {
    const query = this.filter.trim().toLowerCase();
    const files = query ? this.files.filter((path) => path.toLowerCase().includes(query)) : this.files;
    if (this.filesLoading) {
      this.fileListEl.replaceChildren(
        h("div", { class: "skeleton skeleton-line w-80" }),
        h("div", { class: "skeleton skeleton-line w-60" }),
        h("div", { class: "skeleton skeleton-line w-70" }),
      );
      return;
    }
    if (this.filesError) {
      this.fileListEl.replaceChildren(
        h("div", { class: "file-error" },
          h("span", { text: this.filesError }),
          h("button", { class: "ghost-link", type: "button", text: "再試行", onclick: () => this.loadFiles() }),
        ),
      );
      return;
    }
    if (files.length === 0) {
      this.fileListEl.replaceChildren(h("p", { class: "file-empty", text: query ? "一致するファイルがありません" : "ファイルがありません" }));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const path of files.slice(0, 400)) {
      const segments = path.split("/");
      const name = segments.pop() ?? path;
      const dir = segments.join("/");
      const active = path === this.buffer?.path;
      fragment.append(h("button", {
        class: "file-item" + (active ? " active" : ""),
        type: "button",
        role: "option",
        "aria-selected": active,
        title: path,
        onclick: () => this.onOpenFile(path),
      },
      icon("file", 13),
      h("span", { class: "file-name", text: name }),
      dir ? h("span", { class: "file-dir", text: dir }) : null,
      ));
    }
    this.fileListEl.replaceChildren(fragment);
  }

  renderConflict() {
    const conflict = this.buffer?.conflict;
    this.conflictEl.hidden = !conflict;
    if (!conflict) {
      this.conflictEl.replaceChildren();
      return;
    }
    this.conflictEl.replaceChildren(
      icon("alert", 14),
      h("span", { class: "conflict-text", text: "外部で変更されました（v" + formatVersion(conflict.currentVersion) + "）" }),
      h("button", { class: "btn btn-ghost btn-sm", type: "button", text: "再読込", onclick: () => this.reload() }),
      h("button", { class: "btn btn-danger btn-sm", type: "button", text: "上書き保存", onclick: () => this.overwrite() }),
    );
  }

  renderDiff() {
    this.diffEl.replaceChildren();
    if (!this.buffer) return;
    const before = this.buffer.conflict?.external?.content ?? this.buffer.savedContent;
    const after = this.buffer.content;
    const { ops } = diffLines(before, after);
    const { hunks } = diffHunks(ops);
    let added = 0;
    let removed = 0;
    for (const op of ops) {
      if (op.type === "add") added++;
      else if (op.type === "del") removed++;
    }
    if (hunks.length === 0) {
      this.diffEl.append(h("div", { class: "diff-empty", text: "変更はありません。" }));
      return;
    }
    this.diffEl.append(h("div", { class: "diff-summary" },
      h("span", { class: "diff-stat add", text: "+" + added }),
      h("span", { class: "diff-stat del", text: "-" + removed }),
      h("span", { class: "diff-source", text: this.buffer.conflict ? "外部の内容 → 編集中" : "保存済み → 編集中" }),
    ));
    const body = h("div", { class: "diff-body" });
    let oldLine = 1;
    let newLine = 1;
    for (const part of hunks) {
      if (part.type === "skip") {
        body.append(h("div", { class: "diff-skip", text: "… " + part.count + " 行" }));
        oldLine += part.count;
        newLine += part.count;
        continue;
      }
      for (const op of part.ops) {
        const isAdd = op.type === "add";
        const isDel = op.type === "del";
        const row = h("div", { class: "diff-line " + op.type },
          h("span", { class: "diff-gutter", text: isAdd ? "" : String(oldLine) }),
          h("span", { class: "diff-gutter", text: isDel ? "" : String(newLine) }),
          h("span", { class: "diff-sign", text: isAdd ? "+" : isDel ? "-" : " " }),
          h("span", { class: "diff-text", text: op.text }),
        );
        body.append(row);
        if (!isAdd) oldLine++;
        if (!isDel) newLine++;
      }
    }
    this.diffEl.append(body);
  }

  render() {
    this.root.hidden = !this.visible;
    this.root.classList.toggle("open", this.visible);
    const buffer = this.buffer;
    this.pathEl.textContent = buffer?.path ?? (this.path ? this.path : "ファイル未選択");
    this.pathEl.title = buffer?.path ?? this.path ?? "";
    this.versionEl.hidden = !buffer;
    this.versionEl.textContent = buffer ? "v" + formatVersion(buffer.baseVersion) : "";
    this.dirtyEl.hidden = !buffer?.dirty;
    this.saveBtn.disabled = !buffer?.dirty || this.saving;
    this.saveBtn.textContent = this.saving ? "保存中…" : "保存";
    this.reloadBtn.disabled = !buffer;
    this.diffBtn.disabled = !buffer;
    this.diffBtn.classList.toggle("active", this.diffMode);
    this.diffBtn.setAttribute("aria-pressed", String(this.diffMode));
    this.renderConflict();
    this.renderFiles();
    const hasBuffer = Boolean(buffer);
    this.textWrap.hidden = !hasBuffer || this.diffMode;
    this.textEl.hidden = !hasBuffer || this.diffMode;
    this.diffEl.hidden = !hasBuffer || !this.diffMode;
    this.emptyEl.hidden = hasBuffer || this.loading;
    this.loadingEl.hidden = !this.loading;
    this.gutterEl.hidden = !hasBuffer || this.diffMode;
    this.diffEl.classList.toggle("visible", this.diffMode);
    if (this.diffMode) this.renderDiff();
    if (this.loading) {
      this.emptyEl.hidden = true;
    } else if (!hasBuffer) {
      if (this.error) {
        this.emptyEl.replaceChildren(
          icon("alert", 20),
          h("p", { class: "editor-empty-title", text: "ファイルを開けませんでした" }),
          h("p", { class: "editor-empty-desc", text: this.error }),
          h("button", {
            class: "btn btn-ghost btn-sm",
            type: "button",
            text: "再試行",
            onclick: () => this.path && this.open(this.path),
          }),
        );
      } else {
        this.emptyEl.replaceChildren(
          icon("file", 20),
          h("p", { class: "editor-empty-title", text: "ファイルを選択" }),
          h("p", { class: "editor-empty-desc", text: "左の一覧からファイルを開くと、ここで編集できます。" }),
        );
      }
    }
    this.syncDirty();
  }
}

function formatVersion(version) {
  if (!version) return "?";
  const text = String(version);
  const hash = text.startsWith("sha256:") ? text.slice(7) : text;
  return hash.length > 8 ? hash.slice(0, 8) : hash;
}
