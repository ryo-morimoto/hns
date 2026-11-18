import { expect, test } from "vitest";
import { trailLookupFor } from "./trail-lookup.ts";
import type { Store } from "../store.ts";

/**
 * The Workspace Trail lookup (0272n).
 *
 * @remarks
 * The object asks one question before it writes a Change, and the answer is read through the
 * store's Trail repository. The store here is a fake over the real repository interface: what is
 * checked is that the lookup asks the right question, closes what it opens, and answers an
 * absent database with "no Trail" rather than a failure.
 */

/** A store whose Trail repository records what it is asked; `closed` says the store was closed. */
/** A store double needs the repository and the close the lookup reads; nothing else. */
interface StoreView {
  readonly trails: Store["trails"];
  close(): Promise<void>;
}

/** The store double, and the record of what the lookup asked and closed. */
interface FakeStore {
  readonly store: StoreView;
  readonly asked: string[];
  readonly state: { closed: number };
}

/**
 * The store double: the Trail repository the lookup asks, and the close it must call.
 *
 * @remarks
 * The lookup is built over a view of the store, because the view is all it reads: the Trail
 * repository and `close`. The repository is cast once, with the reason stated, because the
 * lookup only reaches `trailForRun` and a full store would need every table this test does not
 * have.
 */
function fakeStore(linked: ReadonlyMap<string, string>): FakeStore {
  const asked: string[] = [];
  const state = { closed: 0 };
  // SAFETY: the lookup asks `trailForRun` and nothing else; the rest of the repository is
  // absent from a test that never reads it.
  const trails = {
    trailForRun: (runId: string) => {
      asked.push(runId);
      return Promise.resolve(linked.get(runId));
    },
  } as Store["trails"];
  return {
    store: {
      trails,
      close: () => {
        state.closed += 1;
        return Promise.resolve();
      },
    },
    asked,
    state,
  };
}

// Catches: the lookup asking another question than the run link, or leaving the store it opened
// unclosed (a store held across Durable Object events).
test("trailForRun asks the store for the run link and closes the store", async () => {
  const { store, asked, state } = fakeStore(new Map([["run-1", "trail-1"]]));
  const lookup = trailLookupFor(() => Promise.resolve(store));
  expect(await lookup.trailForRun("run-1")).toBe("trail-1");
  expect(asked).toStrictEqual(["run-1"]);
  expect(state.closed).toBe(1);
});

// Catches: a run with no link being answered with a Trail (the Change writer would create one).
test("a run with no link has no Trail, and lookupForRun answers no Trail", async () => {
  const { store, state } = fakeStore(new Map());
  const lookup = trailLookupFor(() => Promise.resolve(store));
  expect(await lookup.trailForRun("run-unlinked")).toBeUndefined();
  expect(await lookup.lookupForRun("run-unlinked")).toBeUndefined();
  expect(state.closed).toBe(2);
});

// Catches: a run that is linked getting a repository that is not the one the link was read from.
test("lookupForRun answers the repository the link was read from", async () => {
  const { store } = fakeStore(new Map([["run-2", "trail-2"]]));
  const lookup = trailLookupFor(() => Promise.resolve(store));
  const found = await lookup.lookupForRun("run-2");
  expect(found?.trailId).toBe("trail-2");
  expect(found?.trails).toBe(store.trails);
});

// Catches: a database that cannot be opened being rounded into "no Trail", which would silently
// drop the Change; the failure reaches the Workspace, which logs it.
test("a database that cannot be opened is not an absent link", async () => {
  const lookup = trailLookupFor(() => Promise.reject(new Error("D1 is down")));
  await expect(lookup.trailForRun("run-1")).rejects.toThrow("D1 is down");
});

// Catches: a deployment with no database writing a Change it cannot have read a Trail for.
test("no database answers no Trail", async () => {
  const lookup = trailLookupFor(undefined);
  expect(await lookup.trailForRun("run-1")).toBeUndefined();
  expect(await lookup.lookupForRun("run-1")).toBeUndefined();
});
