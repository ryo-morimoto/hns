import type { LiveSnapshotFrame } from "@hns/core";
import { act } from "react";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { SLOW_SCREEN_TTL_MS } from "../../src/app/freshness.ts";
import { socketFactory } from "../../test/live/support.ts";
import { createTestEnvironment } from "../../test/support/relay.ts";
import {
  countOf,
  renderShell,
  renderShellWith,
  setupShellTestHooks,
} from "../../test/support/shell.tsx";
import { workspaceFixture } from "../../test/support/workspaceFixtures.ts";

setupShellTestHooks();

// Catches: the sidebar reading something else than its own fragments, or a revisit paying for
// the project list that the TTL window is supposed to answer from the store.
test("the shell reads through Relay and a revisit inside the TTL skips the project list", async () => {
  const { environment, calls } = createTestEnvironment(workspaceFixture);
  const first = renderShellWith(environment);
  expect(await screen.findByText("デザインシステムのレビュー")).toBeTruthy();
  expect(calls.map((call) => call.operation)).toStrictEqual([
    "ShellProjectsQuery",
    "ShellWorkspaceQuery",
  ]);

  first.unmount();
  renderShellWith(environment);
  expect(await screen.findByText("デザインシステムのレビュー")).toBeTruthy();
  await waitFor(() => {
    expect(countOf(calls, "ShellWorkspaceQuery")).toBe(2);
  });
  expect(countOf(calls, "ShellProjectsQuery")).toBe(1);
});

// Catches: a conversation list answered from the store and shown stale after a reconnect, or a
// project list that revalidates when the user comes back to the tab inside its window.
test("a TTL screen revalidates on focus only after its window", async () => {
  const { environment, calls } = createTestEnvironment(workspaceFixture);
  renderShellWith(environment);
  await screen.findByText("デザインシステムのレビュー");
  expect(countOf(calls, "ShellProjectsQuery")).toBe(1);

  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(countOf(calls, "ShellProjectsQuery")).toBe(1);
  expect(countOf(calls, "ShellWorkspaceQuery")).toBe(1);

  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + SLOW_SCREEN_TTL_MS);
  try {
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
  } finally {
    clock.mockRestore();
  }
  await waitFor(() => {
    expect(countOf(calls, "ShellProjectsQuery")).toBe(2);
  });
});

// Catches: a failed focus revalidation counted as fresh, so a stale list is not asked for again
// until a whole window has passed. A rejected read leaves the window as it was (D097).
test("a failed focus revalidation is retried on the next focus", async () => {
  let projects = 0;
  const { environment, calls } = createTestEnvironment((call) => {
    if (call.operation === "ShellProjectsQuery") {
      projects += 1;
      if (projects === 2) return undefined;
    }
    return workspaceFixture(call);
  });
  renderShellWith(environment);
  await screen.findByRole("heading", { name: "Workspace" });
  expect(countOf(calls, "ShellProjectsQuery")).toBe(1);

  /** Focus with the clock past the window, the way a user returns to an old tab. */
  function focusAfterWindow(): void {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + SLOW_SCREEN_TTL_MS);
    try {
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
    } finally {
      clock.mockRestore();
    }
  }

  focusAfterWindow();
  await waitFor(() => {
    expect(countOf(calls, "ShellProjectsQuery")).toBe(2);
  });
  await act(async () => undefined);
  // The failed read changed nothing on screen, and it did not start a new window.
  expect(screen.getByRole("heading", { name: "Workspace" })).toBeTruthy();

  focusAfterWindow();
  await waitFor(() => {
    expect(countOf(calls, "ShellProjectsQuery")).toBe(3);
  });
});

// Catches: a live frame updating only the live panel, leaving the sidebar's title on the value
// the last read returned.
test("a live snapshot patches the conversation title without a read", async () => {
  window.location.hash = "#/p/project-hns/c/conversation-intent";
  const { environment, calls } = createTestEnvironment(workspaceFixture);
  const { factory, sockets } = socketFactory();
  renderShellWith(environment, { liveSocket: factory });
  expect(await screen.findByRole("heading", { name: "Web の土台" })).toBeTruthy();
  await waitFor(() => {
    expect(countOf(calls, "ShellWorkspaceQuery")).toBe(1);
  });

  const frame: LiveSnapshotFrame = {
    type: "snapshot",
    protocol: 1,
    cursor: "1",
    conversationId: "conversation-intent",
    title: "名前が変わった会話",
    entries: [],
    draft: "",
  };
  act(() => {
    sockets[0]?.open();
    sockets[0]?.message(frame);
  });

  expect(await screen.findByRole("heading", { name: "名前が変わった会話" })).toBeTruthy();
  expect(
    screen.getAllByRole("link").some((link) => link.textContent === "名前が変わった会話"),
  ).toBe(true);
  expect(countOf(calls, "ShellWorkspaceQuery")).toBe(1);
});

// Catches: a reconnect refetch normalizing the list read over the title the live snapshot set,
// so the open conversation's heading reverts to the title of the last read.
test("a reconnect refetch keeps the live title", async () => {
  window.location.hash = "#/p/project-hns/c/conversation-intent";
  const { environment, calls } = createTestEnvironment(workspaceFixture);
  const { factory, sockets } = socketFactory();
  renderShellWith(environment, { liveSocket: factory });
  expect(await screen.findByRole("heading", { name: "Web の土台" })).toBeTruthy();

  const frame: LiveSnapshotFrame = {
    type: "snapshot",
    protocol: 1,
    cursor: "1",
    conversationId: "conversation-intent",
    title: "名前が変わった会話",
    entries: [],
    draft: "",
  };
  act(() => {
    sockets[0]?.open();
    sockets[0]?.message(frame);
  });
  expect(await screen.findByRole("heading", { name: "名前が変わった会話" })).toBeTruthy();

  act(() => {
    sockets[0]?.drop();
  });
  await waitFor(() => {
    expect(sockets).toHaveLength(2);
  });
  act(() => {
    sockets[1]?.open();
    sockets[1]?.message(frame);
  });

  await waitFor(() => {
    expect(countOf(calls, "ShellWorkspaceQuery")).toBe(2);
  });
  await waitFor(() => {
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("名前が変わった会話");
  });
});

// Catches: a reconnect that heals the socket but leaves the lists as they were before the drop,
// so conversations added while offline never appear.
test("a reconnect refetches the open screen's lists", async () => {
  window.location.hash = "#/p/project-hns/c/conversation-intent";
  const { environment, calls } = createTestEnvironment(workspaceFixture);
  const { factory, sockets } = socketFactory();
  renderShellWith(environment, { liveSocket: factory });
  expect(await screen.findByRole("heading", { name: "Web の土台" })).toBeTruthy();
  act(() => {
    sockets[0]?.open();
  });

  act(() => {
    sockets[0]?.drop();
  });
  await waitFor(() => {
    expect(sockets).toHaveLength(2);
  });
  act(() => {
    sockets[1]?.open();
  });

  await waitFor(() => {
    expect(countOf(calls, "ShellWorkspaceQuery")).toBe(2);
  });
});

// Catches: the conversation route never mounting the live status, so a disconnected user sees nothing.
test("a conversation route shows the live status when a socket is provided", async () => {
  window.location.hash = "#/p/project-hns/c/conversation-intent";
  const { factory, sockets } = socketFactory();
  renderShell({ liveSocket: factory });

  expect(await screen.findByText("ライブ更新に接続しています。")).toBeTruthy();
  act(() => {
    sockets[0]?.open();
  });
  expect(screen.getAllByRole("status").some((element) => element.textContent === "接続済み")).toBe(
    true,
  );

  act(() => {
    sockets[0]?.drop();
  });
  expect(screen.getByText(/1回目の再接続/u)).toBeTruthy();
});
