import assert from "node:assert/strict";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, test } from "vitest";
import { createFixtureSource } from "../../src/app/fixtureSource.ts";
import { Shell } from "../../src/app/Shell.tsx";
import { fixtureSummarySource } from "../../src/app/fixtureSummaries.ts";
import type { WorkspaceSummary } from "../../src/app/workspaceSummary.ts";

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

function renderShell(
  onOpenCommand?: () => void,
  panel?: ReactNode,
  summarySource?: () => Promise<readonly WorkspaceSummary[]>,
) {
  const source = createFixtureSource();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Shell
        source={source}
        onOpenCommand={onOpenCommand}
        panel={panel}
        summarySource={summarySource}
      />
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

test("mobile conversation shows a back arrow to the workspace", async () => {
  setMobile(true);
  window.location.hash = "#/p/project-hns/c/conversation-intent";
  renderShell();

  await screen.findByRole("heading", { name: "Web の土台" });
  assert.equal(screen.queryByRole("button", { name: "メニューを開く" }), null);
  assert.ok(screen.getByText("Web の土台", { selector: ".hns-topbar__title" }));
  await userEvent.click(screen.getByRole("button", { name: "ワークスペースへ戻る" }));

  await screen.findByRole("heading", { name: "Workspace" });
  assert.equal(window.location.hash, "#/p/project-hns");
});

// Catches: the sidebar hiding other workspaces' progress until the user switches.
test("the sidebar shows every workspace's status before switching", async () => {
  renderShell(undefined, undefined, fixtureSummarySource);
  await screen.findByRole("heading", { level: 1, name: "Workspace" });

  assert.ok(await screen.findByRole("link", { name: /^hns: 1 needs · 2 running · 12m/u }));
  assert.ok(screen.getByRole("link", { name: /^docs: 1 running/u }));
  assert.ok(screen.getByRole("link", { name: /^scratch: all clear/u }));

  const labels = screen
    .getAllByRole("link")
    .map((link) => link.getAttribute("aria-label"))
    .filter((label): label is string => label !== null);
  assert.match(labels[0] ?? "", /^hns:/u);
  assert.match(labels[1] ?? "", /^docs:/u);
  assert.match(labels[2] ?? "", /^scratch:/u);

  assert.match(screen.getByText(/^hns 1$/u).textContent ?? "", /hns 1/u);
  assert.match(screen.getByText(/^hns 2 · docs 1$/u).textContent ?? "", /docs 1/u);
  assert.ok(screen.getByRole("group", { name: "Needs you: 1 (hns 1)" }));
  assert.ok(screen.getByRole("group", { name: "Failed: 0" }));
  assert.ok(screen.getByRole("group", { name: "Running: 3 (hns 2 · docs 1)" }));
  assert.ok(screen.getByRole("group", { name: "Done today: 3 (hns 3)" }));
});

test("the active workspace stays first even without needs", async () => {
  window.location.hash = "#/p/project-scratch";
  renderShell(undefined, undefined, fixtureSummarySource);
  await screen.findByRole("heading", { level: 1, name: "Workspace" });

  const labels = screen
    .getAllByRole("link")
    .map((link) => link.getAttribute("aria-label"))
    .filter((label): label is string => label !== null);
  assert.match(labels[0] ?? "", /^scratch:/u);
  assert.match(labels[1] ?? "", /^hns:/u);
});

test("runs stay global when another workspace is active", async () => {
  window.location.hash = "#/p/project-docs";
  renderShell(undefined, undefined, fixtureSummarySource);
  await screen.findByRole("heading", { level: 1, name: "Workspace" });

  const runs = await screen.findByRole("region", { name: "実行" });
  assert.match(runs.textContent ?? "", /workflow-release/u);
  assert.equal(screen.getAllByText("workflow-release").length, 1);
  const body = screen.getByRole("group", { name: "docs の作業" });
  assert.equal(within(body).queryByText("workflow-release"), null);
});

test("the mobile menu carries the needs-you count", async () => {
  setMobile(true);
  renderShell(undefined, undefined, fixtureSummarySource);

  assert.ok(await screen.findByRole("button", { name: "メニュー（Needs you 1）" }));
});

// Catches: a mobile shell that hides the sidebar without a way to reach it, or a drawer that
// traps users. The footer stays composer-first; there is no generic bottom bar (0102, user).
test("mobile opens the drawer from the top bar", async () => {
  setMobile(true);
  renderShell();
  await screen.findByRole("heading", { name: "Workspace" });

  assert.equal(screen.queryByRole("navigation", { name: "下部バー" }), null);
  assert.equal(screen.queryByRole("button", { name: "hns" }), null);
  assert.equal(screen.getByRole("heading", { level: 1 }).textContent, "Workspace");
  assert.ok(screen.getByText("hns", { selector: ".hns-topbar__title" }));

  await userEvent.click(screen.getByRole("button", { name: "メニューを開く" }));
  assert.ok(await screen.findByRole("dialog", { name: "メニュー" }));
  assert.equal(screen.getByRole("status").textContent, "接続済み");
  const themeGroup = screen.getByRole("group", { name: "テーマ" });
  assert.ok(themeGroup);
  await userEvent.click(screen.getByRole("button", { name: "ダーク" }));
  assert.equal(document.documentElement.dataset["theme"], "dark");
  assert.equal(window.localStorage.getItem("hns.theme"), "dark");

  await userEvent.click(screen.getByRole("button", { name: "メニューを閉じる" }));
  await waitFor(() => {
    assert.equal(screen.queryByRole("dialog", { name: "メニュー" }), null);
  });
});
