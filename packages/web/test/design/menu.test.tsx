import assert from "node:assert/strict";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test } from "vitest";
import { Button } from "../../src/components/Button.tsx";
import { Menu } from "../../src/components/Menu.tsx";

test("Menu opens from the keyboard and selects the highlighted item with Enter", async () => {
  let selected = "";
  render(
    <Menu
      label="操作"
      trigger={<Button>操作</Button>}
      items={[
        {
          label: "改名",
          shortcut: "R",
          onSelect: () => {
            selected = "改名";
          },
        },
        { label: "削除", danger: true, onSelect: () => (selected = "削除") },
      ]}
    />,
  );
  const trigger = screen.getByRole("button", { name: "操作" });
  trigger.focus();

  await userEvent.keyboard("{Enter}");
  assert.ok(await screen.findByRole("menu", { name: "操作" }));

  await userEvent.keyboard("{ArrowDown}");
  await userEvent.keyboard("{Enter}");

  await waitFor(() => {
    assert.equal(selected, "削除");
  });
});

test("Escape closes the Menu and returns focus to the trigger", async () => {
  render(
    <Menu
      label="操作"
      trigger={<Button>操作</Button>}
      items={[{ label: "改名", onSelect: () => undefined }]}
    />,
  );
  const trigger = screen.getByRole("button", { name: "操作" });

  await userEvent.click(trigger);
  await screen.findByRole("menu", { name: "操作" });
  await userEvent.keyboard("{Escape}");

  await waitFor(() => {
    assert.equal(screen.queryByRole("menu"), null);
    assert.equal(document.activeElement, trigger);
  });
});

test("a disabled Menu item is not selectable", async () => {
  let selected = false;
  render(
    <Menu
      label="操作"
      trigger={<Button>操作</Button>}
      items={[{ label: "削除", disabled: true, onSelect: () => (selected = true) }]}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: "操作" }));
  const item = await screen.findByRole("menuitem", { name: "削除" });
  await userEvent.click(item);

  assert.equal(selected, false);
});
