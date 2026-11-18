import { expect, test } from "vitest";
import {
  TOOL_PATH_BINDINGS,
  incompleteToolPathMessage,
  toolPathMode,
  type ToolPathEnv,
} from "./tool-path-mode.ts";

// Catches: a deployment that sets two of the three bindings quietly keeping the Phase 0 tools.
// 0270n's whole point is that "partly configured" is a failure at start, not a fallback.

const ALL: ToolPathEnv = {
  HNS_AGENT_URL: "https://machine.example",
  HNS_MACHINE_ID: "machine-1",
  HNS_CONTROL_PLANE_KEY: "seed",
};

test("all three bindings ask for the granted path", () => {
  expect(toolPathMode(ALL)).toEqual({ kind: "granted" });
});

test("none of the bindings keeps the Phase 0 tools", () => {
  expect(toolPathMode({})).toEqual({ kind: "phase0" });
});

// Every one-of-three and two-of-three combination is incomplete, and names exactly what is
// missing and what is set; no combination falls back to either end.
test("a part of the bindings is incomplete and names the missing ones", () => {
  for (const kept of TOOL_PATH_BINDINGS) {
    const mode = toolPathMode({ [kept]: ALL[kept] });
    const missing = TOOL_PATH_BINDINGS.filter((name) => name !== kept);
    expect(mode).toEqual({ kind: "incomplete", missing, present: [kept] });
  }
  for (const kept of TOOL_PATH_BINDINGS) {
    const env: Record<string, string> = {};
    for (const name of TOOL_PATH_BINDINGS) if (name !== kept) env[name] = ALL[name] ?? "";
    const mode = toolPathMode(env);
    expect(mode).toEqual({
      kind: "incomplete",
      missing: [kept],
      present: TOOL_PATH_BINDINGS.filter((name) => name !== kept),
    });
  }
});

// An empty string is a binding the deployment did not fill in; one empty value with two set is
// the same dangerous half-state as an unset one.
test("an empty value counts as absent", () => {
  expect(toolPathMode({ ...ALL, HNS_MACHINE_ID: "" })).toEqual({
    kind: "incomplete",
    missing: ["HNS_MACHINE_ID"],
    present: ["HNS_AGENT_URL", "HNS_CONTROL_PLANE_KEY"],
  });
  expect(
    toolPathMode({ HNS_AGENT_URL: "", HNS_MACHINE_ID: "", HNS_CONTROL_PLANE_KEY: "" }),
  ).toEqual({ kind: "phase0" });
});

// The message names the bindings a person has to add or remove, and never their values.
test("the incomplete message names bindings, never values", () => {
  const message = incompleteToolPathMessage({
    kind: "incomplete",
    missing: ["HNS_MACHINE_ID"],
    present: ["HNS_AGENT_URL", "HNS_CONTROL_PLANE_KEY"],
  });
  expect(message).toContain("HNS_MACHINE_ID");
  expect(message).toContain("HNS_AGENT_URL");
  expect(message).toContain("HNS_CONTROL_PLANE_KEY");
  expect(message).not.toContain("machine.example");
  expect(message).not.toContain("seed");
});
