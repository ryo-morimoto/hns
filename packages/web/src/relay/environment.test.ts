import { fetchQuery } from "relay-runtime";
import { expect, test } from "vitest";
import { ShellProjectsQuery } from "../app/ShellProjects.ts";
import { redirectToLogin } from "../auth/login.ts";
import { createEnvironment } from "./environment.ts";

// Catches: a 401 rendered as a generic failure instead of sending the browser to login.
test("a 401 asks for login and keeps the deep link", async () => {
  const assigned: string[] = [];
  const environment = createEnvironment({
    fetch: () => Promise.resolve(new Response("no", { status: 401 })),
    onUnauthorized: () => {
      redirectToLogin({ pathname: "/p/a/c/b", search: "", hash: "" }, (href) =>
        assigned.push(href),
      );
    },
  });
  await expect(fetchQuery(environment, ShellProjectsQuery, {}).toPromise()).rejects.toThrow(/401/u);
  expect(assigned).toStrictEqual(["/login?next=" + encodeURIComponent("/p/a/c/b")]);
});

// Catches: an outage being treated as a sign-out.
test("a 500 does not send the user to login", async () => {
  let denied = 0;
  const environment = createEnvironment({
    fetch: () => Promise.resolve(new Response("boom", { status: 500 })),
    onUnauthorized: () => {
      denied += 1;
    },
  });
  await expect(fetchQuery(environment, ShellProjectsQuery, {}).toPromise()).rejects.toThrow(/500/u);
  expect(denied).toBe(0);
});
