import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library leaves mounted trees behind; one render per test keeps queries unambiguous.
afterEach(() => {
  cleanup();
});

// jsdom has no layout engine; Base UI's popups consult these two (0101).
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
}

Element.prototype.scrollIntoView = function scrollIntoView(): void {};
