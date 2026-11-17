import { expect, test } from "vitest";
import { agentEntry, doEntry, httpEntry } from "./log.ts";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");

// Catches: the agent's answer text (user/model data) reaching the log.
test("an agent response is logged without its text", () => {
  const entry = agentEntry({
    event: "agent.response",
    at: "2026-11-17T11:59:00.000Z",
    text: "super-secret-answer",
    requestId: "req-1",
  });
  expect(entry).toStrictEqual({
    v: 1,
    at: "2026-11-17T11:59:00.000Z",
    level: "info",
    event: "agent.response",
    hop: "agent",
    requestId: "req-1",
  });
  expect(JSON.stringify(entry)).not.toContain("super-secret-answer");
});

test("a tool result keeps the name, success, and duration only", () => {
  expect(
    agentEntry({
      event: "tool.result",
      at: "2026-11-17T11:59:00.000Z",
      tool: "read_file",
      ok: false,
      ms: 7,
      requestId: "req-1",
    }),
  ).toMatchObject({
    event: "tool.result",
    level: "warn",
    durationMs: 7,
    detail: { tool: "read_file", ok: false },
  });
});

// Catches: a query-string token, header, or body reaching the worker line.
test("an http entry keeps the pathname and status only", () => {
  const entry = httpEntry({
    requestId: "req-1",
    method: "POST",
    path: "/graphql?token=super-secret",
    status: 500,
    durationMs: 3,
    now: NOW,
  });
  expect(entry).toMatchObject({
    event: "http.error",
    hop: "worker",
    level: "error",
    path: "/graphql",
    status: 500,
  });
  expect(JSON.stringify(entry)).not.toContain("token");
  expect(doEntry("req-1", "/rpc/events?limit=1", 200, 2, NOW)).toMatchObject({
    event: "do.rpc",
    hop: "do",
    path: "/rpc/events",
  });
});
