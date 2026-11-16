import { expect, test } from "vitest";
import { ProjectIdSchema } from "@hns/core";
import * as v from "valibot";
import { createTestEnvironment } from "../../test/support/relay.ts";
import { workspaceFixture } from "../../test/support/workspaceFixtures.ts";
import { createRelaySource } from "./relaySource.ts";

// Catches: a read that skips GraphQL, or a global id leaking into the shell as a raw id.
test("projects come from one GraphQL request and keep the model's ids", async () => {
  const calls: string[] = [];
  const { environment } = createTestEnvironment((call) => {
    calls.push(call.operation);
    return workspaceFixture(call);
  });
  const projects = await createRelaySource(environment).listProjects();
  expect(calls).toStrictEqual(["ProjectsQuery"]);
  expect(projects.map((project) => project.id)).toStrictEqual([
    "project-hns",
    "project-scratch",
    "project-docs",
  ]);
  expect(projects[0]?.name).toBe("hns");
});

// Catches: two hooks racing two requests for the same project.
test("conversations and tasks of one project share one request", async () => {
  const calls: string[] = [];
  const { environment } = createTestEnvironment((call) => {
    calls.push(call.operation);
    return workspaceFixture(call);
  });
  const source = createRelaySource(environment);
  const projectId = v.parse(ProjectIdSchema, "project-hns");
  const [conversations, tasks] = await Promise.all([
    source.listConversations(projectId),
    source.listTasks(projectId),
  ]);
  expect(calls).toStrictEqual(["WorkspaceQuery"]);
  expect(conversations.map((conversation) => conversation.id)).toStrictEqual([
    "conversation-intent",
    "conversation-design",
  ]);
  expect(tasks.map((task) => task.status)).toStrictEqual(["doing"]);
});

// Catches: a QueryFailure turned into an empty list instead of an error.
test("a query failure rejects", async () => {
  const { environment } = createTestEnvironment(() => ({
    projects: { __typename: "QueryFailure", code: "UNAVAILABLE", message: "offline" },
  }));
  await expect(createRelaySource(environment).listProjects()).rejects.toThrow(/UNAVAILABLE/u);
});

// Catches: a second open paying for the same read again; the Relay store answers it.
test("a second read of the same project does not hit the network", async () => {
  const calls: string[] = [];
  const { environment } = createTestEnvironment((call) => {
    calls.push(call.operation);
    return workspaceFixture(call);
  });
  const projectId = v.parse(ProjectIdSchema, "project-hns");
  const first = createRelaySource(environment);
  await first.listConversations(projectId);
  const second = createRelaySource(environment);
  await second.listConversations(projectId);
  expect(calls).toStrictEqual(["WorkspaceQuery"]);
});

// Catches: a failed read rendered as an empty workspace.
test("a failed read rejects instead of returning nothing", async () => {
  const { environment } = createTestEnvironment(() => undefined);
  await expect(createRelaySource(environment).listProjects()).rejects.toThrow(/failed/u);
});

// Catches: a cached rejection that makes every retry fail without asking again.
test("a failed read is retried on the next call", async () => {
  let attempts = 0;
  const { environment } = createTestEnvironment((call) => {
    attempts += 1;
    return attempts === 1 ? undefined : workspaceFixture(call);
  });
  const source = createRelaySource(environment);
  await expect(source.listProjects()).rejects.toThrow(/failed/u);
  const projects = await source.listProjects();
  expect(projects.length).toBe(3);
  expect(attempts).toBe(2);
});

// Catches: a non-2xx answer treated as a GraphQL response.
test("a non-2xx response is a network failure", async () => {
  const { environment } = createTestEnvironment(() => undefined);
  const source = createRelaySource(environment);
  await expect(source.listProjects()).rejects.toThrow(/graphql request failed with 500/u);
});
