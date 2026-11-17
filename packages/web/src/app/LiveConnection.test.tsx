import { act, type ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RelayEnvironmentProvider } from "react-relay";
import { snapshotFrame, socketFactory } from "../../test/live/support.ts";
import { createEnvironment } from "../relay/environment.ts";
import { LiveConnection } from "./LiveConnection.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => {
  vi.useRealTimers();
});

/** Render the conversation's live status over an environment whose network is never read. */
function renderLive(element: ReactElement) {
  const environment = createEnvironment({
    fetch: () => Promise.reject(new Error("the live test never reads the network")),
  });
  return render(
    <RelayEnvironmentProvider environment={environment}>{element}</RelayEnvironmentProvider>,
  );
}

// Catches: a disconnected conversation showing only a dot, with no sentence explaining it.
test("the live status explains connecting, online, and reconnecting", () => {
  vi.useFakeTimers();
  const { factory, sockets } = socketFactory();
  renderLive(<LiveConnection conversationId="2" socket={factory} />);

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

// Catches: a first connection reported as a reconnect, so every conversation open refetches the
// screen, or a recovered connection reported never, leaving the lists stale after an outage.
test("a recovered connection is reported as a reconnect, the first one is not", () => {
  vi.useFakeTimers();
  const { factory, sockets } = socketFactory();
  let reconnects = 0;
  renderLive(
    <LiveConnection
      conversationId="2"
      socket={factory}
      onReconnect={() => {
        reconnects += 1;
      }}
    />,
  );

  act(() => {
    sockets[0]?.open();
  });
  expect(reconnects).toBe(0);

  act(() => {
    sockets[0]?.drop();
  });
  act(() => {
    vi.advanceTimersByTime(500);
  });
  act(() => {
    sockets[1]?.open();
  });
  expect(reconnects).toBe(1);
});
