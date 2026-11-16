import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, afterEach, beforeEach, test } from "vitest";
import { RelayEnvironmentProvider } from "react-relay";
import { createTestEnvironment } from "../../test/support/relay.ts";
import { workspaceFixture } from "../../test/support/workspaceFixtures.ts";
import { fixtureSummarySource } from "./fixtureSummaries.ts";
import { Shell } from "./Shell.tsx";
import type { WorkspaceSummary } from "./workspaceSummary.ts";

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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { environment } = createTestEnvironment(workspaceFixture);
  return render(
    <RelayEnvironmentProvider environment={environment}>
      <QueryClientProvider client={queryClient}>
        <Shell onOpenCommand={onOpenCommand} panel={panel} summarySource={summarySource} />
      </QueryClientProvider>
    </RelayEnvironmentProvider>,
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

  expect(await screen.findByRole("heading", { name: "Workspace" })).toBeTruthy();
  expect(await screen.findByRole("link", { name: "デザインシステムのレビュー" })).toBeTruthy();
  expect((await screen.findAllByText("Web の土台")).length).toBeGreaterThan(0);
  expect(window.location.hash).toBe("#/p/project-hns");
});

// Catches: a stale #/... bookmark leaving the shell on a blank workspace.
test("an unknown hash normalizes to the first project", async () => {
  window.location.hash = "#/nope";
  renderShell();

  expect(await screen.findByRole("heading", { name: "Workspace" })).toBeTruthy();
  await waitFor(() => {
    expect(window.location.hash).toBe("#/p/project-hns");
  });
});

test("a conversation route renders the conversation", async () => {
  window.location.hash = "#/p/project-hns/c/conversation-intent";
  renderShell();

  expect(await screen.findByRole("heading", { name: "Web の土台" })).toBeTruthy();
  expect(document.body.textContent ?? "").toMatch(/conversation-intent/u);
});

test("the project menu switches the URL", async () => {
  renderShell();
  await screen.findByRole("heading", { name: "Workspace" });

  await userEvent.click(screen.getByRole("button", { name: "hns" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "scratch" }));

  await waitFor(() => {
    expect(window.location.hash).toBe("#/p/project-scratch");
    expect(document.body.textContent ?? "").toMatch(/scratch · 会話 0 · タスク 0/u);
  });
});

test("the command entry calls its handler", async () => {
  let openings = 0;
  renderShell(() => {
    openings += 1;
  });
  await screen.findByRole("heading", { name: "Workspace" });

  await userEvent.click(screen.getByRole("button", { name: "コマンド" }));

  expect(openings).toBe(1);
});

test("the theme menu applies and stores a theme", async () => {
  renderShell();
  await screen.findByRole("heading", { name: "Workspace" });

  await userEvent.click(screen.getByRole("button", { name: "テーマ" }));
  const system = await screen.findByRole("menuitemradio", { name: "システム" });
  expect(system.getAttribute("aria-checked")).toBe("true");
  await userEvent.click(screen.getByRole("menuitemradio", { name: "ダーク" }));

  expect(document.documentElement.dataset["theme"]).toBe("dark");
  expect(window.localStorage.getItem("hns.theme")).toBe("dark");
});

test("back returns to the previous route", async () => {
  renderShell();
  await screen.findByRole("heading", { name: "Workspace" });

  await userEvent.click(await screen.findByRole("link", { name: "デザインシステムのレビュー" }));
  await screen.findByRole("heading", { name: "デザインシステムのレビュー" });

  window.history.back();

  expect(await screen.findByRole("heading", { name: "Workspace" })).toBeTruthy();
});

// Catches: the editor panel having no slot, so the editor would have to restructure the shell.
test("the shell provides the right panel slot", async () => {
  renderShell(undefined, <p>パネル</p>);
  await screen.findByRole("heading", { name: "Workspace" });

  const panel = screen.getByRole("complementary", { name: "エディタパネル" });
  expect(panel.textContent ?? "").toMatch(/パネル/u);
});

test("mobile conversation shows a back arrow to the workspace", async () => {
  setMobile(true);
  window.location.hash = "#/p/project-hns/c/conversation-intent";
  renderShell();

  await screen.findByRole("heading", { name: "Web の土台" });
  expect(screen.queryByRole("button", { name: "メニューを開く" })).toBe(null);
  expect(screen.getByText("Web の土台", { selector: ".hns-topbar__title" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "ワークスペースへ戻る" }));

  await screen.findByRole("heading", { name: "Workspace" });
  expect(window.location.hash).toBe("#/p/project-hns");
});

// Catches: the sidebar hiding other workspaces' progress until the user switches.
test("the sidebar shows every workspace's status before switching", async () => {
  renderShell(undefined, undefined, fixtureSummarySource);
  await screen.findByRole("heading", { level: 1, name: "Workspace" });

  expect(
    await screen.findByRole("link", { name: /^hns: 1 needs · 2 running · 12m/u }),
  ).toBeTruthy();
  expect(screen.getByRole("link", { name: /^docs: 1 running/u })).toBeTruthy();
  expect(screen.getByRole("link", { name: /^scratch: all clear/u })).toBeTruthy();

  const labels = screen
    .getAllByRole("link")
    .map((link) => link.getAttribute("aria-label"))
    .filter((label): label is string => label !== null);
  expect(labels[0] ?? "").toMatch(/^hns:/u);
  expect(labels[1] ?? "").toMatch(/^docs:/u);
  expect(labels[2] ?? "").toMatch(/^scratch:/u);

  expect(screen.getByText(/^hns 1$/u).textContent ?? "").toMatch(/hns 1/u);
  expect(screen.getByText(/^hns 2 · docs 1$/u).textContent ?? "").toMatch(/docs 1/u);
  expect(screen.getByRole("group", { name: "Needs you: 1 (hns 1)" })).toBeTruthy();
  expect(screen.getByRole("group", { name: "Failed: 0" })).toBeTruthy();
  expect(screen.getByRole("group", { name: "Running: 3 (hns 2 · docs 1)" })).toBeTruthy();
  expect(screen.getByRole("group", { name: "Done today: 3 (hns 3)" })).toBeTruthy();
});

test("the active workspace stays first even without needs", async () => {
  window.location.hash = "#/p/project-scratch";
  renderShell(undefined, undefined, fixtureSummarySource);
  await screen.findByRole("heading", { level: 1, name: "Workspace" });

  const labels = screen
    .getAllByRole("link")
    .map((link) => link.getAttribute("aria-label"))
    .filter((label): label is string => label !== null);
  expect(labels[0] ?? "").toMatch(/^scratch:/u);
  expect(labels[1] ?? "").toMatch(/^hns:/u);
});

// Catches: the run section moving inside a workspace body; runs have no GraphQL projection yet.
test("the run section stays global when another workspace is active", async () => {
  window.location.hash = "#/p/project-docs";
  renderShell(undefined, undefined, fixtureSummarySource);
  await screen.findByRole("heading", { level: 1, name: "Workspace" });

  const runs = await screen.findByRole("region", { name: "実行" });
  expect(runs.textContent ?? "").toMatch(/実行はありません/u);
  const body = screen.getByRole("group", { name: "docs の作業" });
  expect(within(body).queryByRole("region", { name: "実行" })).toBe(null);
});

test("the mobile menu carries the needs-you count", async () => {
  setMobile(true);
  renderShell(undefined, undefined, fixtureSummarySource);

  expect(await screen.findByRole("button", { name: "メニュー（Needs you 1）" })).toBeTruthy();
});

// Catches: a mobile shell that hides the sidebar without a way to reach it, or a drawer that
// traps users. The footer stays composer-first; there is no generic bottom bar.
test("mobile opens the drawer from the top bar", async () => {
  setMobile(true);
  renderShell();
  await screen.findByRole("heading", { name: "Workspace" });

  expect(screen.queryByRole("navigation", { name: "下部バー" })).toBe(null);
  expect(screen.queryByRole("button", { name: "hns" })).toBe(null);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Workspace");
  expect(screen.getByText("hns", { selector: ".hns-topbar__title" })).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "メニューを開く" }));
  expect(await screen.findByRole("dialog", { name: "メニュー" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("接続済み");
  const themeGroup = screen.getByRole("group", { name: "テーマ" });
  expect(themeGroup).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "ダーク" }));
  expect(document.documentElement.dataset["theme"]).toBe("dark");
  expect(window.localStorage.getItem("hns.theme")).toBe("dark");

  await userEvent.click(screen.getByRole("button", { name: "メニューを閉じる" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "メニュー" })).toBe(null);
  });
});
