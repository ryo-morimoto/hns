import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library leaves mounted trees behind; one render per test keeps queries unambiguous.
afterEach(() => {
  cleanup();
});
