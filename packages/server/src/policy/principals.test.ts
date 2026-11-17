import { expect, test } from "vitest";
import { AGENT_SUBJECT_PREFIX, isHumanPrincipal, principalOf } from "./principals.ts";

// Catches: a session subject read as a human when it names the agent namespace, which is how an
// agent credential would reach `decide`.
test("a subject in the agent namespace is an agent principal", () => {
  const actor = principalOf(AGENT_SUBJECT_PREFIX + "agent-1");
  expect(actor).toStrictEqual({ kind: "agent", id: "agent-1" });
  expect(isHumanPrincipal(actor)).toBe(false);
});

// Catches: the person's session (the only one the edge mints today) being read as an agent, which
// would lock every human out of the approval face.
test("a person subject is a human principal", () => {
  const actor = principalOf("owner");
  expect(actor).toStrictEqual({ kind: "human", id: "owner" });
  expect(isHumanPrincipal(actor)).toBe(true);
});

// Catches: a prefix match that swallows a person whose name merely starts the same way.
test("the agent namespace is the prefix and nothing looser", () => {
  expect(principalOf("agentsmith").kind).toBe("human");
  expect(principalOf(AGENT_SUBJECT_PREFIX.slice(0, -1) + ":x").kind).toBe("agent");
});
