import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { fixtureSummarySource } from "../../src/app/fixtureSummaries.ts";
import { renderShell, setMobile, setupShellTestHooks } from "../../test/support/shell.tsx";

setupShellTestHooks();

test("the command entry calls its handler", async () => {
  let openings = 0;
  renderShell({
    onOpenCommand: () => {
      openings += 1;
    },
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

// Catches: the editor panel having no slot, so the editor would have to restructure the shell.
test("the shell provides the right panel slot", async () => {
  renderShell({ panel: <p>パネル</p> });
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

test("the mobile menu carries the needs-you count", async () => {
  setMobile(true);
  renderShell({ summarySource: fixtureSummarySource });

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
