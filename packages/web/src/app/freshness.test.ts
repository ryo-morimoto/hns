import { expect, test } from "vitest";
import {
  DEFAULT_FETCH_POLICY,
  FRESHNESS,
  FRESHNESS_SCREENS,
  SLOW_SCREEN_TTL_MS,
  fetchPolicyFor,
  subscribesToLive,
} from "./freshness.ts";

// Catches: a screen quietly leaving the default, so a stale list is a policy nobody wrote down.
test("every screen that leaves the store-or-network default says why", () => {
  for (const screen of FRESHNESS_SCREENS) {
    const policy = FRESHNESS[screen];
    expect(policy.fetchPolicy).not.toBe(DEFAULT_FETCH_POLICY);
    expect(policy.reason.trim().length).toBeGreaterThan(0);
  }
});

// Catches: a screen that neither subscribes, nor has a TTL, nor reads the network on mount, so
// it would answer from the store forever. A mount read is enough for a list; a TTL is for a
// screen that is revisited without re-mounting and has nothing else to revalidate through.
test("every screen either subscribes, has a TTL, or reads the network on mount", () => {
  for (const screen of FRESHNESS_SCREENS) {
    const policy = FRESHNESS[screen];
    const readsOnMount =
      policy.fetchPolicy === "store-and-network" || policy.fetchPolicy === "network-only";
    expect(policy.subscribes || policy.ttlMs !== null || readsOnMount).toBe(true);
  }
});

// Catches: a TTL window that expires a tick early or a tick late.
test("a screen is answered from the store up to its TTL and leaves it at the boundary", () => {
  expect(
    fetchPolicyFor("projects", { lastFetchedAt: 1_000, now: 1_000 + SLOW_SCREEN_TTL_MS - 1 }),
  ).toBe(DEFAULT_FETCH_POLICY);
  expect(
    fetchPolicyFor("projects", { lastFetchedAt: 1_000, now: 1_000 + SLOW_SCREEN_TTL_MS }),
  ).toBe("store-and-network");
});

// Catches: a first visit that trusts an empty store and renders nothing.
test("a screen that has not read yet goes to the network", () => {
  expect(fetchPolicyFor("projects", { lastFetchedAt: undefined, now: 1_000 })).toBe(
    "store-and-network",
  );
});

// Catches: the conversation transcript read from a cached record that carries no cursor.
test("the conversation screen never reads the store", () => {
  expect(fetchPolicyFor("conversation", { lastFetchedAt: 1_000, now: 1_001 })).toBe("network-only");
  expect(fetchPolicyFor("conversation", { lastFetchedAt: undefined, now: 0 })).toBe("network-only");
  expect(FRESHNESS.conversation.ttlMs).toBeNull();
});

// Catches: the conversation list answered from the store on a revisit, showing a stale Needs you.
test("the workspace list always reads the network", () => {
  expect(fetchPolicyFor("workspace", { lastFetchedAt: 1_000, now: 1_001 })).toBe(
    "store-and-network",
  );
  expect(fetchPolicyFor("workspace", { lastFetchedAt: undefined, now: 0 })).toBe(
    "store-and-network",
  );
});

// Catches: mounting a socket on a screen whose policy says it does not subscribe. The lists are
// not subscribed today: 0159's socket carries one conversation, so a list subscription needs a
// server and protocol change.
test("only the conversation screen asks for a live connection", () => {
  expect(subscribesToLive("conversation")).toBe(true);
  expect(subscribesToLive("workspace")).toBe(false);
  expect(subscribesToLive("projects")).toBe(false);
});
