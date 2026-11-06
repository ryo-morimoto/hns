import assert from "node:assert/strict";
import { render, screen } from "@testing-library/react";
import { test } from "vitest";
import { Badge } from "../../src/components/Badge.tsx";
import { Icon } from "../../src/components/Icon.tsx";
import { Skeleton } from "../../src/components/Skeleton.tsx";

test("Badge renders its tone and text", () => {
  render(<Badge tone="ok">done</Badge>);

  assert.equal(screen.getByText("done").textContent, "done");
});

// Catches: a decorative icon announced as an unnamed image.
test("a decorative Icon is hidden from assistive tech", () => {
  render(<Icon name="check" />);

  assert.equal(screen.queryByRole("img"), null);
});

test("a labelled Icon is an image with its name", () => {
  render(<Icon name="alert" label="警告" size={16} />);

  assert.ok(screen.getByRole("img", { name: "警告" }));
});

test("Skeleton is decorative", () => {
  const { container } = render(<Skeleton width={40} height={10} />);
  const skeleton = container.firstElementChild;

  assert.equal(skeleton?.getAttribute("aria-hidden"), "true");
});
