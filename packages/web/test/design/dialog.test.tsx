import assert from "node:assert/strict";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test } from "vitest";
import { Button } from "../../src/components/Button.tsx";
import { Dialog } from "../../src/components/Dialog.tsx";

test("Dialog opens from its trigger and closes with Escape", async () => {
  render(
    <Dialog trigger={<Button>開く</Button>} title="仕事を頼む" description="ゴールを書く">
      <p>本文</p>
    </Dialog>,
  );

  await userEvent.click(screen.getByRole("button", { name: "開く" }));

  const dialog = await screen.findByRole("dialog", { name: "仕事を頼む" });
  await waitFor(() => {
    assert.ok(dialog.contains(document.activeElement));
  });

  await userEvent.keyboard("{Escape}");

  await waitFor(() => {
    assert.equal(screen.queryByRole("dialog"), null);
  });
});

// Catches: focus left on <body> after a modal closes, stranding keyboard users.
test("closing a Dialog returns focus to the trigger", async () => {
  render(<Dialog trigger={<Button>開く</Button>} title="仕事を頼む" />);
  const trigger = screen.getByRole("button", { name: "開く" });

  await userEvent.click(trigger);
  await screen.findByRole("dialog", { name: "仕事を頼む" });
  await userEvent.keyboard("{Escape}");

  await waitFor(() => {
    assert.equal(document.activeElement, trigger);
  });
});

test("the Dialog close button closes it", async () => {
  render(<Dialog trigger={<Button>開く</Button>} title="仕事を頼む" />);
  await userEvent.click(screen.getByRole("button", { name: "開く" }));
  await screen.findByRole("dialog", { name: "仕事を頼む" });

  await userEvent.click(screen.getByRole("button", { name: "閉じる" }));

  await waitFor(() => {
    assert.equal(screen.queryByRole("dialog"), null);
  });
});
