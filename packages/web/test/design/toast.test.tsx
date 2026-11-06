import assert from "node:assert/strict";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test } from "vitest";
import { Toast } from "../../src/components/Toast.tsx";

test("an information Toast is a status with an Undo action", async () => {
  let undone = 0;
  render(
    <Toast
      message="削除しました"
      action={{
        label: "元に戻す",
        onSelect: () => {
          undone += 1;
        },
      }}
    />,
  );

  const status = screen.getByRole("status");
  assert.match(status.textContent ?? "", /削除しました/u);

  await userEvent.click(screen.getByRole("button", { name: "元に戻す" }));

  assert.equal(undone, 1);
});

// Catches: an error toast announced politely (assertive is the point of role=alert).
test("an error Toast is an alert", () => {
  render(<Toast tone="error" message="保存に失敗しました" />);

  assert.ok(screen.getByRole("alert"));
});

test("Toast dismiss runs its handler", async () => {
  let dismissals = 0;
  render(
    <Toast
      message="保存しました"
      onDismiss={() => {
        dismissals += 1;
      }}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: "閉じる" }));

  assert.equal(dismissals, 1);
});
