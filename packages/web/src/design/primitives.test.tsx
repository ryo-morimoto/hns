import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Badge } from "../components/Badge.tsx";
import { Icon } from "../components/Icon.tsx";
import { Skeleton } from "../components/Skeleton.tsx";

test("Badge renders its tone and text", () => {
  render(<Badge tone="ok">done</Badge>);

  expect(screen.getByText("done").textContent).toBe("done");
});

// Catches: a decorative icon announced as an unnamed image.
test("a decorative Icon is hidden from assistive tech", () => {
  render(<Icon name="check" />);

  expect(screen.queryByRole("img")).toBe(null);
});

test("a labelled Icon is an image with its name", () => {
  render(<Icon name="alert" label="警告" size={16} />);

  expect(screen.getByRole("img", { name: "警告" })).toBeTruthy();
});

test("Skeleton is decorative", () => {
  const { container } = render(<Skeleton width={40} height={10} />);
  const skeleton = container.firstElementChild;

  expect(skeleton?.getAttribute("aria-hidden")).toBe("true");
});
