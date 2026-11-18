import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { toGlobalId } from "@hns/core/graphql";
import { fixtureSummarySource } from "../../src/app/fixtureSummaries.ts";
import { createTestEnvironment } from "../../test/support/relay.ts";
import {
  renderShell,
  renderShellWith,
  RootProbe,
  setupShellTestHooks,
} from "../../test/support/shell.tsx";
import { workspaceFixture } from "../../test/support/workspaceFixtures.ts";

setupShellTestHooks();

test("the project menu switches the URL", async () => {
  renderShell();
  await screen.findByRole("heading", { name: "Workspace" });

  await userEvent.click(screen.getByRole("button", { name: "hns" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "scratch" }));

  await waitFor(() => {
    expect(window.location.hash).toBe("#/p/project-scratch");
    expect(document.body.textContent ?? "").toMatch(/scratch · 会話 0 · Trail 0/u);
  });
});

// Catches: a project switch that leaves the main region or the editor slot on the old root.
test("project switch changes the workspace root and the editor slot's target", async () => {
  const { environment, calls } = createTestEnvironment(workspaceFixture);
  renderShellWith(environment, { panel: <RootProbe /> });
  await screen.findByRole("heading", { name: "Workspace" });
  expect(screen.getByTestId("project-probe").textContent).toBe("project-hns::");
  expect(document.body.textContent ?? "").toMatch(/root: machine ROOT/u);

  await userEvent.click(screen.getByRole("button", { name: "hns" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "scratch" }));

  await waitFor(() => {
    expect(screen.getByTestId("project-probe").textContent).toBe(
      "project-scratch:projects/scratch:projects/scratch",
    );
    expect(document.body.textContent ?? "").toMatch(/root: projects\/scratch/u);
  });
  // The previous project's conversations are not shown under the new one.
  expect(screen.queryByRole("link", { name: "デザインシステムのレビュー" })).toBe(null);
  expect(document.body.textContent ?? "").toMatch(/scratch · 会話 0 · Trail 0/u);
  const workspaceCalls = calls.filter((call) => call.operation === "ShellWorkspaceQuery");
  expect(workspaceCalls.at(-1)?.variables["projectId"]).toBe(
    toGlobalId("Project", "project-scratch"),
  );
});

// Catches: the sidebar hiding other workspaces' progress until the user switches.
test("the sidebar shows every workspace's status before switching", async () => {
  renderShell({ summarySource: fixtureSummarySource });
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
  renderShell({ summarySource: fixtureSummarySource });
  await screen.findByRole("heading", { level: 1, name: "Workspace" });

  await waitFor(() => {
    const labels = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("aria-label"))
      .filter((label): label is string => label !== null);
    expect(labels[0] ?? "").toMatch(/^scratch:/u);
    expect(labels[1] ?? "").toMatch(/^hns:/u);
  });
});

// Catches: the run section moving inside a workspace body; runs have no GraphQL projection yet.
test("the run section stays global when another workspace is active", async () => {
  window.location.hash = "#/p/project-docs";
  renderShell({ summarySource: fixtureSummarySource });
  await screen.findByRole("heading", { level: 1, name: "Workspace" });

  const runs = await screen.findByRole("region", { name: "実行" });
  expect(runs.textContent ?? "").toMatch(/実行はありません/u);
  const body = screen.getByRole("group", { name: "docs の作業" });
  expect(within(body).queryByRole("region", { name: "実行" })).toBe(null);
});
