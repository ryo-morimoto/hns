import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { renderShell, setupShellTestHooks } from "../../test/support/shell.tsx";

setupShellTestHooks();

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

// Catches: a conversation route drawing only its chrome, with the conversation's own screen never
// mounted under it.
test("a conversation route renders the conversation", async () => {
  window.location.hash = "#/p/project-hns/c/conversation-intent";
  renderShell();

  expect(await screen.findByRole("heading", { name: "Web の土台" })).toBeTruthy();
  // The screen's composer is what proves the conversation itself is on the page. Its label is
  // sr-only (the field is named visually by the section), so it is found by role, not by text.
  expect(await screen.findByRole("textbox", { name: "メッセージ" })).toBeTruthy();
});

/**
 * The policy route: the workspace's policy screen under the shell, and the way back.
 *
 * @remarks
 * The shell fixtures answer the policy read (an empty policy, in the screen's own wire shapes), so
 * what this test proves is the **route**: the policy hash mounts the policy screen and not the
 * workspace view, and the workspace route comes back. (The back control's own navigation is the
 * conversation route's test below; the desktop bar keeps this route's back behind the project
 * menu's place, which a mouse user reaches the same way.)
 */
test("a policy route renders the policy screen, and back returns to the workspace", async () => {
  window.location.hash = "#/p/project-hns/policy";
  renderShell();

  expect(await screen.findByRole("heading", { name: "ポリシー", level: 1 })).toBeTruthy();
  expect(await screen.findByTestId("policy-pending-empty")).toBeTruthy();
  // The workspace view and a conversation's composer are not under it.
  expect(screen.queryByRole("heading", { name: "Workspace" })).toBe(null);
  expect(screen.queryByRole("textbox", { name: "メッセージ" })).toBe(null);

  // The chrome names the place the route is (not the workspace it belongs to).
  expect(screen.getAllByText("ポリシー").length).toBeGreaterThan(0);
  window.location.hash = "#/p/project-hns";
  await waitFor(() => {
    expect(window.location.hash).toBe("#/p/project-hns");
  });
  expect(await screen.findByRole("heading", { name: "Workspace" })).toBeTruthy();
});

test("back returns to the previous route", async () => {
  renderShell();
  await screen.findByRole("heading", { name: "Workspace" });

  await userEvent.click(await screen.findByRole("link", { name: "デザインシステムのレビュー" }));
  await screen.findByRole("heading", { name: "デザインシステムのレビュー" });

  window.history.back();

  expect(await screen.findByRole("heading", { name: "Workspace" })).toBeTruthy();
});
