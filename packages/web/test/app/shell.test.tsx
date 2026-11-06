import assert from "node:assert/strict";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, test } from "vitest";
import { createWebClient } from "../../src/api/client.ts";
import { createFixtureFetch } from "../../src/api/fixtures.ts";
import { Shell } from "../../src/app/Shell.tsx";

const originalMatchMedia = window.matchMedia;

function setMobile(mobile: boolean): void {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: mobile && query.includes("max-width: 768px"),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
}

function renderShell(onOpenCommand?: () => void, panel?: ReactNode) {
  const client = createWebClient({ baseUrl: "", fetch: createFixtureFetch() });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Shell client={client} onOpenCommand={onOpenCommand} panel={panel} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "";
  setMobile(false);
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

test("the shell renders fixtures and defaults to the first project", async () => {
  renderShell();

  assert.ok(await screen.findByRole("heading", { name: "Workspace" }));
  assert.ok(await screen.findByRole("link", { name: "デザインシステムのレビュー" }));
  assert.ok((await screen.findAllByText("Web の土台")).length > 0);
  assert.equal(window.location.hash, "#/p/project-hns");
});

// Catches: a stale #/... bookmark leaving the shell on a blank workspace.
test("an unknown hash normalizes to the first project", async () => {
  window.location.hash = "#/nope";
  renderShell();

  assert.ok(await screen.findByRole("heading", { name: "Workspace" }));
  await waitFor(() => {
    assert.equal(window.location.hash, "#/p/project-hns");
  });
});

test("a conversation route renders the conversation", async () => {
  window.location.hash = "#/p/project-hns/c/conversation-intent";
  renderShell();

  assert.ok(await screen.findByRole("heading", { name: "Web の土台" }));
  assert.match(document.body.textContent ?? "", /conversation-intent/u);
});

test("the project menu switches the URL", async () => {
  renderShell();
  await screen.findByRole("heading", { name: "Workspace" });

  await userEvent.click(screen.getByRole("button", { name: "hns" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "scratch" }));

  await waitFor(() => {
    assert.equal(window.location.hash, "#/p/project-scratch");
    assert.match(document.body.textContent ?? "", /scratch · 会話 0 · タスク 0/u);
  });
});

test("the command entry calls its handler", async () => {
  let openings = 0;
  renderShell(() => {
    openings += 1;
  });
  await screen.findByRole("heading", { name: "Workspace" });

  await userEvent.click(screen.getByRole("button", { name: "コマンド" }));

  assert.equal(openings, 1);
});

test("the theme menu applies and stores a theme", async () => {
  renderShell();
  await screen.findByRole("heading", { name: "Workspace" });

  await userEvent.click(screen.getByRole("button", { name: "テーマ" }));
  const system = await screen.findByRole("menuitemradio", { name: "システム" });
  assert.equal(system.getAttribute("aria-checked"), "true");
  await userEvent.click(screen.getByRole("menuitemradio", { name: "ダーク" }));

  assert.equal(document.documentElement.dataset["theme"], "dark");
  assert.equal(window.localStorage.getItem("hns.theme"), "dark");
});

test("back returns to the previous route", async () => {
  renderShell();
  await screen.findByRole("heading", { name: "Workspace" });

  await userEvent.click(await screen.findByRole("link", { name: "デザインシステムのレビュー" }));
  await screen.findByRole("heading", { name: "デザインシステムのレビュー" });

  window.history.back();

  assert.ok(await screen.findByRole("heading", { name: "Workspace" }));
});

// Catches: the editor panel having no slot, so 0106 has to restructure the shell.
test("the shell provides the right panel slot", async () => {
  renderShell(undefined, <p>パネル</p>);
  await screen.findByRole("heading", { name: "Workspace" });

  const panel = screen.getByRole("complementary", { name: "エディタパネル" });
  assert.match(panel.textContent ?? "", /パネル/u);
});

// Catches: a mobile shell that hides the sidebar without a way to reach it, or a drawer that
// traps users. The footer stays composer-first; there is no generic bottom bar (0102, user).
test("mobile opens the drawer from the top bar", async () => {
  setMobile(true);
  renderShell();
  await screen.findByRole("heading", { name: "Workspace" });

  assert.equal(screen.queryByRole("navigation", { name: "下部バー" }), null);

  await userEvent.click(screen.getByRole("button", { name: "メニューを開く" }));
  assert.ok(await screen.findByRole("dialog", { name: "メニュー" }));

  await userEvent.click(screen.getByRole("button", { name: "メニューを閉じる" }));
  await waitFor(() => {
    assert.equal(screen.queryByRole("dialog", { name: "メニュー" }), null);
  });
});
