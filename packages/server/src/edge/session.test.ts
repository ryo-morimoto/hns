import { expect, test } from "vitest";
import { MIN_SESSION_SECRET_LENGTH, readSessionCookie, signSession } from "./session.ts";
import { sessionCookie, signRawPayload, TEST_SECRET } from "../../test/support/edge.ts";

const NOW = 1_800_000_000_000;

test("a signed session round-trips", async () => {
  const header = await sessionCookie("owner", NOW + 60_000);
  const session = await readSessionCookie(header, TEST_SECRET, NOW);
  expect(session).toStrictEqual({ subject: "owner", expiresAt: NOW + 60_000 });
});

test("a missing or short secret is a denial", async () => {
  const header = await sessionCookie("owner", NOW + 60_000);
  const almost = "a".repeat(MIN_SESSION_SECRET_LENGTH - 1);
  expect(await readSessionCookie(header, undefined, NOW)).toBeNull();
  expect(await readSessionCookie(header, almost, NOW)).toBeNull();
});

test("an expired cookie is a denial", async () => {
  const header = await sessionCookie("owner", NOW - 1);
  expect(await readSessionCookie(header, TEST_SECRET, NOW)).toBeNull();
});

// Catches: a tampered payload that still authenticates.
test("a tampered cookie is a denial", async () => {
  const header = await sessionCookie("owner", NOW + 60_000);
  const value = header.slice("hns_session=".length);
  const last = value.slice(-1);
  const tampered = value.slice(0, -1) + (last === "A" ? "B" : "A");
  expect(await readSessionCookie("hns_session=" + tampered, TEST_SECRET, NOW)).toBeNull();
});

test("a cookie signed with another secret is a denial", async () => {
  const header = await sessionCookie("owner", NOW + 60_000, "another-secret-0123456789abcdef0123");
  expect(await readSessionCookie(header, TEST_SECRET, NOW)).toBeNull();
});

// Catches: a duplicated cookie being resolved to the first value by accident.
test("a duplicated cookie is a denial", async () => {
  const header = await sessionCookie("owner", NOW + 60_000);
  expect(await readSessionCookie(header + "; " + header, TEST_SECRET, NOW)).toBeNull();
});

test("other cookies do not interfere", async () => {
  const header = await sessionCookie("owner", NOW + 60_000);
  const session = await readSessionCookie("theme=dark; " + header + "; other=1", TEST_SECRET, NOW);
  expect(session?.subject).toBe("owner");
});

test("a malformed cookie is a denial", async () => {
  for (const value of ["abc", "a.b.c", "!!!.???", "a.b"]) {
    expect(await readSessionCookie("hns_session=" + value, TEST_SECRET, NOW)).toBeNull();
  }
});

// Catches: a signed payload with an unknown version or an empty subject being accepted.
test("a signed but invalid payload is a denial", async () => {
  const exp = Math.floor((NOW + 60_000) / 1000);
  const payloads = [
    "{not json",
    JSON.stringify({ v: 2, sub: "owner", exp }),
    JSON.stringify({ v: 1, sub: "", exp }),
    JSON.stringify({ v: 1, sub: "owner", exp: -1 }),
  ];
  for (const payload of payloads) {
    const value = await signRawPayload(TEST_SECRET, payload);
    expect(await readSessionCookie("hns_session=" + value, TEST_SECRET, NOW)).toBeNull();
  }
});

test("signing refuses an empty subject, a short secret, or a non-finite expiry", async () => {
  const almost = "a".repeat(MIN_SESSION_SECRET_LENGTH - 1);
  await expect(signSession(almost, { subject: "owner", expiresAt: NOW })).rejects.toThrow();
  await expect(signSession(TEST_SECRET, { subject: "", expiresAt: NOW })).rejects.toThrow();
  await expect(
    signSession(TEST_SECRET, { subject: "owner", expiresAt: Number.NaN }),
  ).rejects.toThrow();
});
