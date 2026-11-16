import { act } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { snapshotFrame, socketFactory } from "../../test/live/support.ts";
import { LiveConnection } from "./LiveConnection.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => {
  vi.useRealTimers();
});

// Catches: a disconnected conversation showing only a dot, with no sentence explaining it.
test("the live status explains connecting, online, and reconnecting", () => {
  vi.useFakeTimers();
  const { factory, sockets } = socketFactory();
  render(<LiveConnection conversationId="2" socket={factory} />);

  expect(screen.getByRole("status").textContent).toBe("接続中");
  expect(screen.getByText("ライブ更新に接続しています。")).toBeTruthy();

  act(() => {
    sockets[0]?.open();
  });
  expect(screen.getByRole("status").textContent).toBe("接続済み");
  expect(screen.getByText("ライブ更新を受信しています。")).toBeTruthy();

  act(() => {
    sockets[0]?.message(snapshotFrame("3"));
  });
  expect(screen.getByRole("status").textContent).toBe("接続済み");

  act(() => {
    sockets[0]?.drop();
  });
  expect(screen.getByRole("status").textContent).toBe("再接続中");
  expect(screen.getByText(/1回目の再接続/u)).toBeTruthy();

  act(() => {
    vi.advanceTimersByTime(500);
  });
  expect(sockets).toHaveLength(2);
  expect(sockets[1]?.url).toContain("cursor=3");
});
