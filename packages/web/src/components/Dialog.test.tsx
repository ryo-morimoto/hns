import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { Button } from "./Button.tsx";
import { Dialog } from "./Dialog.tsx";

test("Dialog opens from its trigger and closes with Escape", async () => {
  render(
    <Dialog trigger={<Button>開く</Button>} title="仕事を頼む" description="ゴールを書く">
      <p>本文</p>
    </Dialog>,
  );

  await userEvent.click(screen.getByRole("button", { name: "開く" }));

  const dialog = await screen.findByRole("dialog", { name: "仕事を頼む" });
  await waitFor(() => {
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  await userEvent.keyboard("{Escape}");

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBe(null);
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
    expect(document.activeElement).toBe(trigger);
  });
});

test("the Dialog close button closes it", async () => {
  render(<Dialog trigger={<Button>開く</Button>} title="仕事を頼む" />);
  await userEvent.click(screen.getByRole("button", { name: "開く" }));
  await screen.findByRole("dialog", { name: "仕事を頼む" });

  await userEvent.click(screen.getByRole("button", { name: "閉じる" }));

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBe(null);
  });
});
