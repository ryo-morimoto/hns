import { act, useEffect, useRef, type ReactElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { snapshotFrame, socketFactory } from "../../test/live/support.ts";
import type { LiveSocketFactory } from "../live/client.ts";
import type { LiveConversationState } from "../live/state.ts";
import { useLiveConnection } from "../live/useLiveConnection.ts";
import { LiveConnection } from "./LiveConnection.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The conversation route as a test drives it: it owns the one connection and draws the status.
 *
 * @param props.socket - The socket factory the visit opens.
 * @param props.onReconnect - Called when a dropped connection is healthy again.
 * @param props.onState - Receives the live state on every change.
 *
 * @remarks
 * The route is what owns the connection (the screen never opens one), so this stands in for it:
 * the same hook, the same status line, and the same report upward.
 */
function RouteLike({
  socket,
  onReconnect,
  onState,
}: {
  readonly socket: LiveSocketFactory;
  readonly onReconnect: () => void;
  readonly onState: (state: LiveConversationState) => void;
}): ReactElement {
  const live = useLiveConnection("2", { socket });
  onState(live.state);
  const previous = useRef(live.state.status);
  useEffect(() => {
    const reconnected = previous.current === "reconnecting" && live.state.status === "online";
    previous.current = live.state.status;
    if (reconnected) onReconnect();
  }, [live.state.status, onReconnect]);
  return <LiveConnection state={live.state} label />;
}

// Catches: a disconnected conversation showing only a dot, with no sentence explaining it.
test("the status line says what the connection is doing", () => {
  vi.useFakeTimers();
  const { factory, sockets } = socketFactory();
  render(<RouteLike socket={factory} onReconnect={() => undefined} onState={() => undefined} />);

  expect(screen.getByText("ライブ更新に接続しています。")).toBeTruthy();

  act(() => {
    sockets[0]?.open();
  });
  expect(screen.getByText("ライブ更新を受信しています。")).toBeTruthy();

  act(() => {
    sockets[0]?.message(snapshotFrame("3"));
  });
  expect(screen.getByText("ライブ更新を受信しています。")).toBeTruthy();

  act(() => {
    sockets[0]?.drop();
  });
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
  render(
    <RouteLike
      socket={factory}
      onState={() => undefined}
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

// Catches: the route keeping its state to itself, so the status line never leaves "connecting"
// while the socket is up.
test("the route's state carries what the screen draws", () => {
  const { factory, sockets } = socketFactory();
  let latest: LiveConversationState | undefined;
  render(
    <RouteLike
      socket={factory}
      onReconnect={() => undefined}
      onState={(state) => {
        latest = state;
      }}
    />,
  );
  act(() => {
    sockets[0]?.open();
    sockets[0]?.message(snapshotFrame("4", [{ id: "4", kind: "pi.user", text: "hi" }]));
  });
  expect(latest?.status).toBe("online");
  expect(latest?.entries.map((entry) => entry.id)).toStrictEqual(["4"]);
  cleanup();
});
