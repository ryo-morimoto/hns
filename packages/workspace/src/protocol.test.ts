import { expect, test } from "vitest";
import { parseReply } from "./protocol.ts";

const readReply = (base64: string, size: number): string =>
  JSON.stringify({ ok: true, base64, size });

// Catches: a cut base64 payload decoded to fewer bytes without an error, so corrupt content read as valid.
test("a read reply shorter than its size fails as io", () => {
  const full = Buffer.from("0123456789").toString("base64");
  const cut = full.slice(0, 8);

  const outcome = parseReply("read", readReply(cut, 10));

  expect(outcome.kind).toBe("failed");
  expect(outcome.kind === "failed" ? outcome.code : undefined).toBe("io");
});

// Catches: a read reply that lost its size was accepted as content.
test("a read reply without a size is unreadable", () => {
  const outcome = parseReply("read", JSON.stringify({ ok: true, base64: "aGVsbG8=" }));

  expect(outcome.kind).toBe("failed");
  expect(outcome.kind === "failed" ? outcome.code : undefined).toBe("io");
});

test("a read reply with a matching size decodes to its bytes", () => {
  const bytes = Buffer.from("hello");

  const outcome = parseReply("read", readReply(bytes.toString("base64"), bytes.length));

  expect(outcome).toStrictEqual({ kind: "content", bytes });
});
