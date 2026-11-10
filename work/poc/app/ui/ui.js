// Small DOM and interaction primitives. No framework: the PoC is plain JS.
// Every surface uses these so focus, motion, and copy stay consistent.

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "value" && "value" in node) node.value = value;
    else if (key === "checked" && "checked" in node) node.checked = value;
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

const ICONS = {
  plus: ["M8 3v10", "M3 8h10"],
  search: ["M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z", "M10.4 10.4L14 14"],
  message: ["M2.5 4.5A1.5 1.5 0 0 1 4 3h8a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 12 11H6l-3.5 2.5z"],
  file: ["M4 2h5l3 3v9H4z", "M9 2v3h3"],
  folder: ["M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z"],
  panel: ["M2.5 3h11v10h-11z", "M9.5 3v10"],
  send: ["M8 13V3", "M4.5 6.5L8 3l3.5 3.5"],
  stop: ["M5.5 5.5h5v5h-5z"],
  check: ["M3 8.5l3 3 7-7"],
  alert: ["M8 2.5l6 10.5H2z", "M8 6v3.2", "M8 11.4v.1"],
  sun: ["M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z", "M8 1v1.5", "M8 13.5V15", "M1 8h1.5", "M13.5 8H15", "M3 3l1 1", "M12 12l1 1", "M13 3l-1 1", "M4 12l-1 1"],
  moon: ["M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5z"],
  monitor: ["M3 3h10v7H3z", "M8 10v3", "M6 13h4"],
  archive: ["M2.5 4h11v3h-11z", "M4 7v6h8V7", "M6 9.5h4"],
  trash: ["M3 4.5h10", "M6 4.5V3h4v1.5", "M4.5 4.5l.5 9h6l.5-9", "M6.5 7v4", "M9.5 7v4"],
  pencil: ["M3 13l.5-3L11 2.5l2.5 2.5L6 12.5z", "M9.5 4l2.5 2.5"],
  refresh: ["M13 8a5 5 0 1 1-1.5-3.5", "M13 2.5V6h-3.5"],
  diff: ["M4 2v12", "M2 4h4", "M10 4h4", "M12 2v4", "M3 11h6"],
  copy: ["M5.5 5.5h7v7h-7z", "M3.5 10.5h-1v-7h7v1"],
  keyboard: ["M2.5 5h11v6h-11z", "M5 8h.5", "M7.5 8h.5", "M10 8h.5", "M5 10h6"],
  help: ["M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2z", "M6.5 6.5a1.5 1.5 0 1 1 2.2 1.3c-.5.3-.7.6-.7 1.2", "M8 11.4v.1"],
  activity: ["M2 8h3l2-4 2 8 2-4h3"],
  clock: ["M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z", "M8 5v3.5l2 1"],
  arrowDown: ["M8 3v10", "M4.5 9.5L8 13l3.5-3.5"],
  layers: ["M8 2l6 3-6 3-6-3z", "M2 8l6 3 6-3", "M2 11l6 3 6-3"],
  inbox: ["M2.5 9.5V12h11V9.5", "M2.5 9.5L4.5 4h7l2 5.5", "M2.5 9.5H6l.5 1.5h3l.5-1.5h3.5"],
  chevronLeft: ["M10 3.5L5.5 8l4.5 4.5"],
  chevronDown: ["M4 6l4 4 4-4"],
  chevronRight: ["M6 4l4 4-4 4"],
  more: ["M4 8h.01", "M8 8h.01", "M12 8h.01"],
  close: ["M4 4l8 8", "M12 4l-8 8"],
  external: ["M9 3h4v4", "M13 3L7 9", "M12 10v3H3V4h3"],
};

export function icon(name, size = 16) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of ICONS[name] ?? []) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

export const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
export function modKey(key) {
  return isMac ? "⌘" + key : "Ctrl+" + key;
}

const RELATIVE = new Intl.RelativeTimeFormat("ja", { numeric: "auto" });
const DATE = new Intl.DateTimeFormat("ja-JP", { month: "short", day: "numeric" });
const TIME = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function relativeTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = (then - Date.now()) / 1000;
  const abs = Math.abs(seconds);
  if (abs < 45) return "たった今";
  if (abs < 3600) return RELATIVE.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return RELATIVE.format(Math.round(seconds / 3600), "hour");
  if (abs < 86400 * 7) return RELATIVE.format(Math.round(seconds / 86400), "day");
  return DATE.format(then);
}

export function clockTime(value = Date.now()) {
  return TIME.format(new Date(value));
}

export function formatTokens(value) {
  const n = Number(value ?? 0);
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
  return String(n);
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return total + "秒";
  const minutes = Math.floor(total / 60);
  return minutes + "分" + String(total % 60).padStart(2, "0") + "秒";
}

export function debounce(fn, wait = 150) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

// ---- Modal dialogs -------------------------------------------------------

function mountModal(build) {
  const dialog = document.querySelector("#modal");
  if (!dialog) return { dialog: null, result: Promise.resolve(null) };
  if (dialog.open) dialog.close("cancel");
  dialog.replaceChildren();
  const result = new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue || "cancel"), { once: true });
  });
  dialog.append(build(dialog));
  dialog.showModal();
  return { dialog, result };
}

export function promptText({ title, description, label = "", value = "", placeholder = "", confirmLabel = "保存", danger = false }) {
  const { dialog, result } = mountModal(() => {
    const input = h("input", {
      class: "field",
      type: "text",
      value,
      placeholder,
      autocomplete: "off",
      required: true,
    });
    const form = h("form", { method: "dialog", class: "modal-form" },
      h("div", { class: "modal-head" },
        h("h2", { class: "modal-title", text: title }),
        description ? h("p", { class: "modal-desc", text: description }) : null,
      ),
      h("label", { class: "field-label" },
        h("span", { text: label }),
        input,
      ),
      h("div", { class: "modal-actions" },
        h("button", { class: "btn btn-ghost", type: "submit", value: "cancel", formnovalidate: true, text: "キャンセル" }),
        h("button", { class: "btn " + (danger ? "btn-danger" : "btn-primary"), type: "submit", value: "ok", text: confirmLabel }),
      ),
    );
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return form;
  });
  return result.then((outcome) => {
    if (outcome !== "ok" || !dialog) return null;
    const input = dialog.querySelector("input.field");
    return input?.value.trim() || null;
  });
}

export function promptLongText({ title, description, label = "", value = "", placeholder = "", confirmLabel = "送信", rows = 6 }) {
  const { dialog, result } = mountModal(() => {
    const input = h("textarea", {
      class: "field field-area",
      rows,
      placeholder,
      spellcheck: "false",
    });
    input.value = value;
    const form = h("form", { method: "dialog", class: "modal-form" },
      h("div", { class: "modal-head" },
        h("h2", { class: "modal-title", text: title }),
        description ? h("p", { class: "modal-desc", text: description }) : null,
      ),
      h("label", { class: "field-label" },
        h("span", { text: label }),
        input,
      ),
      h("div", { class: "modal-actions" },
        h("button", { class: "btn btn-ghost", type: "submit", value: "cancel", text: "キャンセル" }),
        h("button", { class: "btn btn-primary", type: "submit", value: "ok", text: confirmLabel }),
      ),
    );
    requestAnimationFrame(() => input.focus());
    return form;
  });
  return result.then((outcome) => {
    if (outcome !== "ok" || !dialog) return null;
    return dialog.querySelector("textarea.field")?.value ?? "";
  });
}

export function confirmAction({ title, description, confirmLabel = "実行", danger = false }) {
  const { result } = mountModal(() => h("form", { method: "dialog", class: "modal-form" },
    h("div", { class: "modal-head" },
      h("h2", { class: "modal-title", text: title }),
      description ? h("p", { class: "modal-desc", text: description }) : null,
    ),
    h("div", { class: "modal-actions" },
      h("button", { class: "btn btn-ghost", type: "submit", value: "cancel", text: "キャンセル" }),
      h("button", { class: "btn " + (danger ? "btn-danger" : "btn-primary"), type: "submit", value: "ok", text: confirmLabel, autofocus: danger ? undefined : true }),
    ),
  ));
  return result.then((outcome) => outcome === "ok");
}

export function infoDialog({ title, description, body, confirmLabel = "閉じる" }) {
  const { result } = mountModal(() => h("form", { method: "dialog", class: "modal-form modal-wide" },
    h("div", { class: "modal-head" },
      h("h2", { class: "modal-title", text: title }),
      description ? h("p", { class: "modal-desc", text: description }) : null,
    ),
    body ?? null,
    h("div", { class: "modal-actions" },
      h("button", { class: "btn btn-primary", type: "submit", value: "ok", text: confirmLabel, autofocus: true }),
    ),
  ));
  return result;
}

// ---- Toasts --------------------------------------------------------------

export function toast(message, { kind = "info", action = null, duration = 5000 } = {}) {
  const container = document.querySelector("#toasts");
  if (!container) return () => {};
  const icons = { info: "activity", success: "check", error: "alert", warn: "alert" };
  const node = h("div", { class: "toast toast-" + kind, role: kind === "error" ? "alert" : "status" },
    icon(icons[kind] ?? "activity", 14),
    h("span", { class: "toast-text", text: message }),
    action ? h("button", {
      class: "toast-action",
      type: "button",
      text: action.label,
      onclick: () => { action.run(); dismiss(); },
    }) : null,
    h("button", { class: "toast-close", type: "button", "aria-label": "閉じる", onclick: () => dismiss() }, icon("close", 12)),
  );
  let timer = setTimeout(() => dismiss(), duration);
  node.addEventListener("mouseenter", () => clearTimeout(timer));
  node.addEventListener("mouseleave", () => { timer = setTimeout(() => dismiss(), 1500); });
  function dismiss() {
    clearTimeout(timer);
    if (!node.isConnected) return;
    node.classList.add("leaving");
    setTimeout(() => node.remove(), 160);
  }
  while (container.children.length >= 4) container.firstElementChild?.remove();
  container.append(node);
  return dismiss;
}

// ---- Menus ---------------------------------------------------------------

let activeMenu = null;
let activeMenuCleanup = null;

export function closeMenu() {
  if (!activeMenu) return;
  activeMenu.remove();
  activeMenu = null;
  activeMenuCleanup?.();
  activeMenuCleanup = null;
}

export function openMenu(anchor, items, { align = "start" } = {}) {
  closeMenu();
  const menu = h("div", { class: "menu", role: "menu" });
  const buttons = [];
  for (const item of items) {
    if (item === null || item === undefined) continue;
    if (item.separator) {
      menu.append(h("div", { class: "menu-sep", role: "separator" }));
      continue;
    }
    const button = h("button", {
      class: "menu-item" + (item.danger ? " danger" : ""),
      type: "button",
      role: "menuitem",
      disabled: item.disabled,
      onclick: () => {
        if (item.disabled) return;
        closeMenu();
        item.onSelect?.();
      },
    },
    item.icon ? icon(item.icon, 14) : h("span", { class: "menu-noicon" }),
    h("span", { class: "menu-label", text: item.label }),
    item.shortcut ? h("kbd", { class: "menu-shortcut", text: item.shortcut }) : null,
    );
    buttons.push(button);
    menu.append(button);
  }
  document.body.append(menu);
  anchor.setAttribute("aria-expanded", "true");

  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = align === "end" ? rect.right - width : rect.left;
  let top = rect.bottom + 6;
  if (left + width > innerWidth - margin) left = innerWidth - width - margin;
  if (left < margin) left = margin;
  if (top + height > innerHeight - margin) top = rect.top - height - 6;
  if (top < margin) top = margin;
  menu.style.left = left + "px";
  menu.style.top = top + "px";

  const onPointer = (event) => {
    if (!menu.contains(event.target) && !anchor.contains(event.target)) closeMenu();
  };
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      anchor.focus();
      return;
    }
    if (event.key === "Tab") {
      closeMenu();
      return;
    }
    const enabled = buttons.filter((button) => !button.disabled);
    const index = enabled.indexOf(document.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      enabled[(index + 1 + enabled.length) % enabled.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      enabled[(index - 1 + enabled.length) % enabled.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      enabled[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      enabled.at(-1)?.focus();
    }
  };
  document.addEventListener("pointerdown", onPointer, true);
  document.addEventListener("keydown", onKey, true);
  activeMenu = menu;
  activeMenuCleanup = () => {
    anchor.removeAttribute("aria-expanded");
    document.removeEventListener("pointerdown", onPointer, true);
    document.removeEventListener("keydown", onKey, true);
  };
  requestAnimationFrame(() => (buttons.find((button) => !button.disabled) ?? menu).focus?.());
  return closeMenu;
}

// ---- Clipboard & text ----------------------------------------------------

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("コピーしました", { kind: "success", duration: 2200 });
  } catch {
    const area = h("textarea", { class: "offscreen" });
    area.value = text;
    document.body.append(area);
    area.select();
    try { document.execCommand("copy"); toast("コピーしました", { kind: "success", duration: 2200 }); }
    catch { toast("コピーできませんでした", { kind: "error" }); }
    finally { area.remove(); }
  }
}

function linkify(text) {
  const fragment = document.createDocumentFragment();
  const pattern = /https?:\/\/[^\s<>()]+/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) fragment.append(document.createTextNode(text.slice(last, match.index)));
    const label = match[0];
    try {
      const url = new URL(label);
      fragment.append(h("a", { href: url.href, target: "_blank", rel: "noreferrer noopener", text: label }));
    } catch {
      fragment.append(document.createTextNode(label));
    }
    last = match.index + label.length;
  }
  if (last < text.length) fragment.append(document.createTextNode(text.slice(last)));
  return fragment;
}

function renderInline(text) {
  const fragment = document.createDocumentFragment();
  const pieces = text.split(/(`[^`\n]+`)/g);
  for (const piece of pieces) {
    if (piece.startsWith("`") && piece.endsWith("`") && piece.length > 2) {
      fragment.append(h("code", { class: "inline-code", text: piece.slice(1, -1) }));
    } else if (piece) {
      fragment.append(linkify(piece));
    }
  }
  return fragment;
}

/** Fenced code, inline code, and bare URLs. Everything is inserted as text nodes. */
export function renderMessageText(text) {
  const fragment = document.createDocumentFragment();
  let rest = String(text ?? "");
  while (rest.length > 0) {
    const fence = rest.indexOf("```");
    if (fence === -1) {
      fragment.append(renderInline(rest));
      break;
    }
    if (fence > 0) fragment.append(renderInline(rest.slice(0, fence)));
    const after = rest.slice(fence + 3);
    const newline = after.indexOf("\n");
    const lang = (newline === -1 ? after : after.slice(0, newline)).trim();
    const start = newline === -1 ? after.length : newline + 1;
    const close = after.indexOf("```", start);
    const code = close === -1 ? after.slice(start) : after.slice(start, close);
    const block = h("div", { class: "code-block" },
      h("div", { class: "code-head" },
        h("span", { text: lang || "code" }),
        h("button", {
          class: "code-copy",
          type: "button",
          title: "コピー",
          "aria-label": "コードをコピー",
          onclick: () => copyText(code),
        }, icon("copy", 12), h("span", { text: "コピー" })),
      ),
      h("pre", { class: "code-body" }, h("code", { text: code })),
    );
    fragment.append(block);
    rest = close === -1 ? "" : after.slice(close + 3);
  }
  return fragment;
}
