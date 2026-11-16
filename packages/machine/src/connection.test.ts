import { expect, test } from "vitest";
import { ConnectionGate } from "./connection.ts";

test("a newer connection takes over and the older one is stale", () => {
  const gate = new ConnectionGate();
  expect(gate.admit("connection-1", 1)).toStrictEqual({ kind: "admitted" });
  expect(gate.admit("connection-1", 1)).toStrictEqual({ kind: "admitted" });
  expect(gate.admit("connection-2", 1)).toStrictEqual({ kind: "stale", floor: 1 });
  expect(gate.admit("connection-2", 2)).toStrictEqual({ kind: "admitted" });
  expect(gate.admit("connection-1", 1)).toStrictEqual({ kind: "stale", floor: 2 });
  expect(gate.admit("connection-1", 2)).toStrictEqual({ kind: "stale", floor: 2 });
  expect(gate.admit("connection-2", 2)).toStrictEqual({ kind: "admitted" });
  expect(gate.admit("connection-2", 3)).toStrictEqual({ kind: "admitted" });
  expect(gate.admit("connection-1", 2)).toStrictEqual({ kind: "stale", floor: 3 });
});

test("a seq that is not a positive integer is stale", () => {
  const gate = new ConnectionGate();
  expect(gate.admit("connection-1", 0)).toStrictEqual({ kind: "stale", floor: 0 });
  expect(gate.admit("connection-1", -1)).toStrictEqual({ kind: "stale", floor: 0 });
  expect(gate.admit("connection-1", 1.5)).toStrictEqual({ kind: "stale", floor: 0 });
  expect(gate.admit("connection-1", Number.MAX_SAFE_INTEGER + 1)).toStrictEqual({
    kind: "stale",
    floor: 0,
  });
  expect(gate.floor).toBe(0);
});
