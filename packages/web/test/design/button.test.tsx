import assert from "node:assert/strict";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test } from "vitest";
import { Button } from "../../src/components/Button.tsx";

test("Button runs its action on click", async () => {
  let clicks = 0;
  render(<Button onClick={() => (clicks += 1)}>保存</Button>);

  await userEvent.click(screen.getByRole("button", { name: "保存" }));

  assert.equal(clicks, 1);
});

test("a disabled Button refuses the press", async () => {
  let clicks = 0;
  render(
    <Button disabled onClick={() => (clicks += 1)}>
      保存
    </Button>,
  );

  await userEvent.click(screen.getByRole("button", { name: "保存" }));

  assert.equal(clicks, 0);
});

// Catches: a loading button that still submits, or hides its busy state from assistive tech.
test("a loading Button is busy and refuses the press", async () => {
  let clicks = 0;
  render(
    <Button loading onClick={() => (clicks += 1)}>
      保存
    </Button>,
  );
  const button = screen.getByRole("button", { name: "保存" });
  assert.ok(button instanceof HTMLButtonElement);
  assert.equal(button.getAttribute("aria-busy"), "true");
  assert.equal(button.disabled, true);

  await userEvent.click(button);

  assert.equal(clicks, 0);
});

test("an icon Button exposes its accessible name", () => {
  render(
    <Button variant="icon" aria-label="閉じる">
      ×
    </Button>,
  );

  assert.ok(screen.getByRole("button", { name: "閉じる" }));
});
