import { expect, test } from "vitest";
import { fromGlobalId, toGlobalId, type GlobalId, type GlobalIdResult } from "./global-id.ts";

test("a global id round-trips to its type and id", () => {
  const globalId = toGlobalId("Project", "default");
  const expected: GlobalId = { type: "Project", id: "default" };
  expect(fromGlobalId(globalId)).toStrictEqual({ ok: true, value: expected });
});

// Catches: omitting the type prefix, so Conversation 1 and Item 1 collide in Relay's store.
test("the same raw id under two types yields different global ids", () => {
  expect(toGlobalId("Conversation", "1")).not.toBe(toGlobalId("Item", "1"));
  expect(fromGlobalId(toGlobalId("Item", "1"))).toStrictEqual({
    ok: true,
    value: { type: "Item", id: "1" },
  });
});

// Catches: a malformed id that throws instead of returning a typed failure.
test("a malformed global id fails without throwing", () => {
  for (const value of ["", "!!!", "not-base64", "T25seVR5cGU", "OnByb2plY3Q6", "On0"]) {
    expect(fromGlobalId(value)).toStrictEqual({ ok: false, reason: "malformed" });
  }
});

// Catches: a programming error (empty type/id, reserved characters) encoded silently.
test("encoding refuses a bad type or an empty id", () => {
  expect(() => toGlobalId("", "default")).toThrow(/GraphQL name/u);
  expect(() => toGlobalId("Project:", "default")).toThrow(/GraphQL name/u);
  expect(() => toGlobalId("Project", "")).toThrow(/empty/u);
});

test("an id may contain a colon and still round-trip", () => {
  const globalId = toGlobalId("Project", "a:b");
  const decoded: GlobalIdResult = fromGlobalId(globalId);
  expect(decoded).toStrictEqual({ ok: true, value: { type: "Project", id: "a:b" } });
});
