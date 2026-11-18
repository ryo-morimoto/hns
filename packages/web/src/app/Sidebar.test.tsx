import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { TRAIL_GROUP_LABELS, TRAIL_GROUPS, type TrailGroup } from "../../src/app/viewModel.ts";
import { renderShell, setupShellTestHooks } from "../../test/support/shell.tsx";

setupShellTestHooks();

/**
 * The group a test reads by its heading.
 *
 * @param label - The heading text (Needs you, Active, Observing, Closed).
 * @returns The group element, which lists that group's Trails.
 */
function group(label: TrailGroup) {
  return screen.getByRole("group", { name: TRAIL_GROUP_LABELS[label] });
}

// Catches: a Trail shown under the wrong heading, or the Sidebar dropping one of them (C3).
test("the sidebar lists a Trail under its state's list", async () => {
  renderShell();
  await screen.findByRole("heading", { level: 1, name: "Workspace" });

  expect(within(group("needs-you")).getByText("レビューを待つ")).toBeTruthy();
  expect(within(group("active")).getByText("Web の土台")).toBeTruthy();
  expect(within(group("observing")).getByText("観測中の変更")).toBeTruthy();
  expect(within(group("closed")).getByText("終わった作業")).toBeTruthy();
  // A Trail appears in exactly one list: a review is not also under Active.
  expect(within(group("active")).queryByText("レビューを待つ")).toBe(null);
  expect(within(group("needs-you")).queryByText("Web の土台")).toBe(null);
});

// Catches: the Sidebar becoming a board again (D104: no kanban, no columns).
test("the sidebar shows lists, not a board of columns", async () => {
  renderShell();
  await screen.findByRole("heading", { level: 1, name: "Workspace" });

  // The four lists are groups of Trails, in the order the principle names.
  const names = screen
    .getAllByRole("group")
    .filter((element) => element.hasAttribute("data-group"))
    .map((element) => element.getAttribute("aria-label"));
  expect(names).toStrictEqual(TRAIL_GROUPS.map((groupName) => TRAIL_GROUP_LABELS[groupName]));
  // No board and no columns: neither the elements nor the classes a board would need exist.
  expect(document.querySelector('[role="listbox"], [role="grid"], [data-column]')).toBe(null);
  // Each Trail is a row with its state beside it, not a card in a column. The title links to the
  // Trail's review face (0232), and the state stays a sibling the row carries.
  for (const trail of ["レビューを待つ", "Web の土台", "観測中の変更", "終わった作業"]) {
    // A conversation may share a Trail's title; a Trail's link is the one the Sidebar's list
    // makes, `#/p/<project>/t/<trail>`.
    const row = screen.getByText(trail, { selector: "li a[href*='/t/']" }).closest("li");
    expect(row?.className).toBe("hns-sidebar__row");
    expect(row?.querySelector(".hns-sidebar__state")?.textContent ?? "").not.toBe("");
  }
});

// Catches: the four lists disappearing when the workspace has no Trail, which would read as a
// broken screen rather than "nothing is waiting".
test("every list is shown even when the workspace has no Trail", async () => {
  window.location.hash = "#/p/project-scratch";
  renderShell();
  await screen.findByRole("heading", { level: 1, name: "Workspace" });

  expect(screen.getByText("Trail はありません")).toBeTruthy();
  const lists = screen
    .getAllByRole("group")
    .filter((element) => element.hasAttribute("data-group"));
  expect(lists).toHaveLength(TRAIL_GROUPS.length);
});
