import { expect, test } from "vitest";
import { LOGIN_PATH, loginHref, nextPathFrom, redirectToLogin } from "./login.ts";

// Catches: a deep link lost across the login redirect.
test("the login URL carries the whole deep link and returns it", () => {
  const href = loginHref({
    pathname: "/p/project-hns",
    search: "",
    hash: "#/p/project-hns/c/conversation-1",
  });
  expect(href).toBe(
    LOGIN_PATH + "?next=" + encodeURIComponent("/p/project-hns#/p/project-hns/c/conversation-1"),
  );
  const search = href?.slice(href.indexOf("?")) ?? "";
  expect(nextPathFrom(search)).toBe("/p/project-hns#/p/project-hns/c/conversation-1");
});

// Catches: a crafted next value sending the browser off the application.
test("only a local path is restored", () => {
  expect(nextPathFrom("?next=%2Fp%2Fa")).toBe("/p/a");
  expect(nextPathFrom("?next=%2F%23%2Fp%2Fa")).toBe("/#/p/a");
  for (const unsafe of [
    "?next=https%3A%2F%2Fevil.example",
    "?next=%2F%2Fevil.example",
    "?next=%5C%5Cevil.example",
    "?next=%2F%5Cevil.example",
    "?next=javascript%3Aalert(1)",
    "?next=%2Flogin",
    "?next=%2Flogin%3Fnext%3D%252Fp%252Fa",
  ]) {
    expect(nextPathFrom(unsafe)).toBeNull();
  }
  expect(nextPathFrom("")).toBeNull();
});

// Catches: a 401 loop while already on the login screen.
test("a client already on /login is not redirected again", () => {
  const assigned: string[] = [];
  redirectToLogin({ pathname: LOGIN_PATH, search: "", hash: "" }, (href) => assigned.push(href));
  expect(assigned).toStrictEqual([]);
  expect(loginHref({ pathname: LOGIN_PATH, search: "?next=%2Fp%2Fa", hash: "" })).toBeNull();
});

test("a 401 navigates to the login URL and keeps the deep link", () => {
  const assigned: string[] = [];
  redirectToLogin({ pathname: "/", search: "", hash: "#/p/project-hns/c/conversation-1" }, (href) =>
    assigned.push(href),
  );
  expect(assigned).toStrictEqual([
    LOGIN_PATH + "?next=" + encodeURIComponent("/#/p/project-hns/c/conversation-1"),
  ]);
});
