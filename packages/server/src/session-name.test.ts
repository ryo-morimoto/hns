import { expect, test } from "vitest";
import { LEGACY_SESSION_NAME, sessionNameFor } from "./session-name.ts";

// Catches: the default project moved to another object, orphaning the conversations already there.
test("the default project keeps the object name the deployment already used", () => {
  expect(sessionNameFor("default")).toBe(LEGACY_SESSION_NAME);
});

// Catches: two projects sharing one Session object, which would mix their conversations.
test("a project's object name is its id", () => {
  expect(sessionNameFor("p1")).toBe("p1");
  expect(sessionNameFor("p1")).not.toBe(sessionNameFor("p2"));
});

// Catches: an unnamed project silently addressing the default object.
test("an empty project id is refused", () => {
  expect(() => sessionNameFor("")).toThrow();
});
