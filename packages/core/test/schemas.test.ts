import { test } from "vitest";
import assert from "node:assert/strict";
import * as v from "valibot";
import { ChatRequestSchema, ErrorResponseSchema, TaskUpdateSchema } from "../src/schemas.ts";
import {
  assertNodeTransition,
  assertRunTransition,
  canNodeTransition,
  canRunTransition,
} from "../src/workflow.ts";

test("a chat request accepts a message", () => {
  const parsed = v.parse(ChatRequestSchema, { message: "hello" });

  assert.equal(parsed.message, "hello");
});

test("a chat request rejects an empty message", () => {
  assert.throws(() => v.parse(ChatRequestSchema, { message: "" }));
});

test("a task update accepts a known status", () => {
  const parsed = v.parse(TaskUpdateSchema, { status: "doing" });

  assert.equal(parsed.status, "doing");
});

test("a task update rejects an unknown status", () => {
  assert.throws(() => v.parse(TaskUpdateSchema, { status: "paused" }));
});

test("an error response carries a known code", () => {
  const parsed = v.parse(ErrorResponseSchema, { code: "unauthorized", message: "no" });

  assert.equal(parsed.code, "unauthorized");
});

test("an error response rejects an unknown code", () => {
  assert.throws(() => v.parse(ErrorResponseSchema, { code: "teapot", message: "no" }));
});

test("run transitions only move forward", () => {
  assert.equal(canRunTransition("queued", "running"), true);
  assert.equal(canRunTransition("done", "running"), false);
  assert.throws(() => assertRunTransition("done", "running"));
});

test("node transitions allow waiting to resume", () => {
  assert.equal(canNodeTransition("waiting", "running"), true);
  assert.equal(canNodeTransition("done", "waiting"), false);
  assert.throws(() => assertNodeTransition("done", "waiting"));
});
