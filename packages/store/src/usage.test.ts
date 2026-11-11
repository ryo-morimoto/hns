import { expect, test } from "vitest";
import { withStore } from "../test/support.ts";

test("usage is recorded and summed for the day", () => {
  withStore((store) => {
    store.usage.add({ tokens: 3, cost: 0.25 });
    store.usage.add({ tokens: 4, cost: 0.5 });
    expect(store.usage.today()).toStrictEqual({ turns: 2, tokens: 7, cost: 0.75 });
    expect(store.usage.today("2026-01-02")).toStrictEqual({ turns: 0, tokens: 0, cost: 0 });
  });
});
