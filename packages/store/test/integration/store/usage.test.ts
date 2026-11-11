import { afterAll, beforeAll, expect, test } from "vitest";
import { createD1Harness, type D1Harness } from "../harness.ts";

let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

test("usage is recorded and summed for the day", async () => {
  await harness.withStore(async (store) => {
    await store.usage.add({ tokens: 3, cost: 0.25 });
    await store.usage.add({ tokens: 4, cost: 0.5 });
    expect(await store.usage.today()).toStrictEqual({ turns: 2, tokens: 7, cost: 0.75 });
    expect(await store.usage.today("2026-01-02")).toStrictEqual({
      turns: 0,
      tokens: 0,
      cost: 0,
    });
  });
});
