import { expect, test } from "vitest";
import { INDEX_DRAIN_BATCH } from "./index-batch.ts";
import {
  ABSENT_VERSION,
  EVENT_NAMES,
  MUTATION_UNKNOWN_REASONS,
  type AbsentVersion,
  type FileRead,
  type MutationResult,
} from "./types.ts";

// Catches: absence spelled with a missing field or a null, so a caller cannot tell a free name
// from a version it failed to read.
test("absence is a version, not a missing field", () => {
  expect(ABSENT_VERSION).toBe("absent");
  const absent: AbsentVersion = ABSENT_VERSION;
  const present: AbsentVersion = "sha256:" + "0".repeat(64);
  const read: FileRead = { path: "a.txt", content: "", version: absent };
  const conflict: MutationResult = {
    status: "conflict",
    operationId: "op-1",
    currentVersion: present,
  };
  expect(read.version).toBe("absent");
  expect(conflict.status === "conflict" ? conflict.currentVersion : undefined).toBe(present);
});

// Catches: a write answer naming a reason the Journal cannot store, or the Journal storing a
// reason the machine never answers with.
test("the machine and the Journal take the unknown reasons from one list", () => {
  expect(MUTATION_UNKNOWN_REASONS).toStrictEqual(["io", "crash", "timeout"]);
});

// Catches: an index event written as free JSON under a name the log would refuse when read back.
test("the index events are in the closed event vocabulary", () => {
  for (const name of ["index.rebuilt", "index.drain.failed", "index.state.failed"]) {
    expect(EVENT_NAMES).toContain(name);
  }
});

test("one index drain covers a fixed number of conversations", () => {
  expect(INDEX_DRAIN_BATCH).toBe(50);
});
