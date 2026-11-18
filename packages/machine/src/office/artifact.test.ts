import { expect, test } from "vitest";
import { MAX_ARTIFACT_BYTES, artifactTarget, officeParamsHash } from "@hns/core/office";
import { MachineRefusal } from "../refusal.ts";
import { verifyArtifactTarget } from "./artifact.ts";

// The artifact route's input check is the whole of "the query is the one that was signed": the
// verifier hashes the request target the client sent, and the machine compares what it parsed
// with the canonical spelling of itself. Each test states a query a rewriter could produce and the
// refusal it must get *before* the signature is even tried.

/** The target every test starts from: a well-formed preview read. */
async function target(
  overrides: Record<string, string | number | undefined> = {},
): Promise<string> {
  return artifactTarget({
    workspaceId: "ws-1",
    path: "提案書.docx",
    version: "sha256:" + "a".repeat(64),
    operation: "preview",
    paramsHash: await officeParamsHash("preview", {}),
    ...overrides,
  });
}

/** The refusal one target is answered with, or undefined when it is accepted. */
function refusalOf(value: string): MachineRefusal | undefined {
  try {
    verifyArtifactTarget(value);
    return undefined;
  } catch (error) {
    if (error instanceof MachineRefusal) return error;
    throw error;
  }
}

// Catches: the canonical target refused (a route that rejects every read), and a parse that does
// not round-trip the query it just accepted.
test("C11: the canonical target is accepted, and its key is read back", async () => {
  const accepted = await target({ offset: 0, length: 1024 });
  const query = verifyArtifactTarget(accepted);
  expect(query.operation).toBe("preview");
  expect(query.path).toBe("提案書.docx");
  expect(query.offset).toBe(0);
  expect(query.length).toBe(1024);
});

// Catches: a query whose parameters were reordered, which is valid but not the spelling that was
// signed. The signature covers the bytes, and a reordered query is different bytes.
test("C14: a reordered query is refused", async () => {
  const canonical = await target();
  const question = canonical.indexOf("?");
  const pairs = canonical.slice(question + 1).split("&");
  const reordered = canonical.slice(0, question) + "?" + pairs.slice().reverse().join("&");
  expect(reordered).not.toBe(canonical);
  expect(refusalOf(reordered)?.code).toBe("invalid_request");
});

// Catches: a query with a parameter appended or repeated, so a reader could take a second value
// for a key it already had.
test("C14: an extra or repeated parameter is refused", async () => {
  const canonical = await target();
  // A range is written in its own place, right after the key's five parts, so an appended
  // `&length=10` is exactly the canonical spelling of that range and is accepted.
  expect(refusalOf(canonical + "&length=10")).toBeUndefined();
  const parts = canonical.split("&");
  expect(refusalOf([parts[0], "length=10", ...parts.slice(1)].join("&"))?.code).toBe(
    "invalid_request",
  );
  // An unknown key does not parse at all.
  expect(refusalOf(canonical + "&session=abc")?.code).toBe("invalid_request");
  expect(
    refusalOf(canonical.replace("workspaceId=ws-1", "workspaceId=ws-1&workspaceId=ws-2"))?.code,
  ).toBe("invalid_request");
});

// Catches: the range read as unbounded (a `length` over 8 MiB would be a 50 MiB answer) and a
// negative or fractional range.
test("C11: a range over the artifact bound or not a number is refused", async () => {
  expect(refusalOf(await target({ length: MAX_ARTIFACT_BYTES + 1 }))?.code).toBe("invalid_request");
  expect(refusalOf(await target({ length: MAX_ARTIFACT_BYTES }))).toBeUndefined();
  expect(refusalOf((await target()) + "&offset=-1")?.code).toBe("invalid_request");
  expect(refusalOf((await target()) + "&offset=1.5")?.code).toBe("invalid_request");
});

// Catches: a query that names an operation the cache does not hold (a conversion, or a word the
// contract has no artifact for), or a key part outside its spelling.
test("C11: a key part outside its spelling, or an operation with no artifact, is refused", async () => {
  // The version is percent-encoded in the target, so the test rewrites the encoded spelling it
  // actually sends; `md5:` is not a version the contract has, and the pair is the right shape.
  expect(refusalOf((await target()).replace("sha256%3A", "md5%3A"))?.code).toBe("invalid_request");
  expect(
    refusalOf((await target()).replace(/paramsHash=[0-9a-f]{16}/u, "paramsHash=XYZ"))?.code,
  ).toBe("invalid_request");
  expect(refusalOf((await target()).replace("operation=preview", "operation=convert"))?.code).toBe(
    "invalid_request",
  );
});

// Catches: a request with no query at all answered as an artifact (a reader could reach the cache's
// directory listing or a default entry).
test("a target with no query, or a different route, is refused", async () => {
  expect(refusalOf("/artifact")?.code).toBe("invalid_request");
  expect(refusalOf("")?.code).toBe("invalid_request");
});

// B1 — the byte-exact comparison. docs §5 says the machine verifies the request target it received
// against the canonical one, and the *encoding* is part of the target: two escapes that decode to
// the same character are two different sets of bytes, and the signature covers one of them. A check
// that compares only the decoded values (which is what "the names are right and it parses" amounts
// to) lets a rewritten target through, which is what this test refuses.
test("B1: the same key in another encoding of the same character is refused", async () => {
  const canonical = await target();
  // The path is 提案書.docx: %E6%8F%90 starts with an upper-case escape, and %e6%8f%90 decodes to the
  // same character. Both are valid percent-encoding; only one is the target the server signed.
  expect(canonical).toContain("%E6%8F%90");
  const lowerCase = canonical.replace("%E6%8F%90", "%e6%8f%90");
  expect(lowerCase).not.toBe(canonical);
  expect(decodeURIComponent(lowerCase)).toBe(decodeURIComponent(canonical));
  expect(refusalOf(lowerCase)?.code).toBe("invalid_request");
  // The same for the version, whose ":" is written %3A: %3a is the same value in other bytes.
  const lowerColon = canonical.replace("sha256%3A", "sha256%3a");
  expect(decodeURIComponent(lowerColon)).toBe(decodeURIComponent(canonical));
  expect(refusalOf(lowerColon)?.code).toBe("invalid_request");
  // A space is written %20 by the canonical spelling; `+` is the other form a query reader
  // accepts for it, and it decodes to the same path under URLSearchParams, so only the byte
  // comparison can refuse it.
  const spaced = await target({ path: "a b.docx" });
  expect(spaced).toContain("a%20b.docx");
  const plus = spaced.replace("a%20b.docx", "a+b.docx");
  expect([...new URLSearchParams(plus.slice(plus.indexOf("?") + 1)).entries()]).toStrictEqual([
    ...new URLSearchParams(spaced.slice(spaced.indexOf("?") + 1)).entries(),
  ]);
  expect(plus).not.toBe(spaced);
  expect(refusalOf(plus)?.code).toBe("invalid_request");
});

// B1 — the positive half: the canonical target of every range shape is accepted, so the byte
// comparison is not so strict that a legitimate read is refused.
test("B1: every canonical range shape round-trips", async () => {
  for (const range of [{}, { offset: 0 }, { length: 1024 }, { offset: 4096, length: 1024 }]) {
    const canonical = await target(range);
    expect(refusalOf(canonical), JSON.stringify(range)).toBeUndefined();
    const parsed = verifyArtifactTarget(canonical);
    expect(parsed.workspaceId).toBe("ws-1");
    expect(parsed.path).toBe("提案書.docx");
    expect(parsed.operation).toBe("preview");
    // An absent range is absent, not 0: a zero-length read is not "the whole".
    expect(parsed.offset).toBe("offset" in range ? range.offset : undefined);
    expect(parsed.length).toBe("length" in range ? range.length : undefined);
  }
});
