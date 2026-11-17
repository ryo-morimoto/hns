/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- the corpus is untrusted args of every shape,
   which is exactly what canonicalize is asked to accept or refuse. */
import { expect, test } from "vitest";
import {
  UnsupportedFormatError,
  argsHash,
  callHash,
  canonicalize,
  digestCall,
  manifestHash,
  policyHash,
  reviewToken,
  sha256Hex,
} from "./canonical.ts";
import type { PolicyDocument, ToolCall, ToolManifest } from "./types.ts";

// RFC 8785 vectors (Appendix B) in the shapes Phase 1 accepts, as (JSON text with escapes, exact
// canonical text). The RFC floats (333333333.33333329, 1e30, 4.5, 0.002, 1e-27) are refused by this
// contract and are their own case below.
const RFC_8785_VECTORS: ReadonlyArray<readonly [string, string]> = [
  ['[56,{"d":true,"10":null,"1":[]}]', '[56,{"1":[],"10":null,"d":true}]'],
  ['"\\u20ac$"', '"\u20ac$"'],
  ['"\\u00b2"', '"\u00b2"'],
  ['"\\ud83d\\ude00"', '"\ud83d\ude00"'],
  [
    '{"\\u0000":"NUL","\\u0041":"A","\\u0007":"Bell","1":"One"}',
    '{"\\u0000":"NUL","\\u0007":"Bell","1":"One","A":"A"}',
  ],
  ['{"a":0,"b":-0,"c":1}', '{"a":0,"b":0,"c":1}'],
];

// Catches: a canonical form that drifts from RFC 8785 for the shapes hns actually hashes (arrays,
// objects, booleans, null, Unicode, control characters, the sort order of keys, integer zeroes).
test("canonicalize reproduces the RFC 8785 vectors", () => {
  for (const [input, expected] of RFC_8785_VECTORS) {
    // SAFETY: the vector is JSON text; JSON.parse yields the value the vector describes.
    const value = JSON.parse(input) as unknown;
    expect(canonicalize(value)).toBe(expected);
  }
});

// Catches: hashing a float the RFC allows (333333333.33333329, 4.5) or a non-safe integer (1e30),
// which Phase 1 must refuse rather than guess a representation for.
test("a number that is not a safe integer has no canonical form", () => {
  expect(() => canonicalize([333_333_333.33])).toThrow(UnsupportedFormatError);
  expect(() => canonicalize(1e30)).toThrow(UnsupportedFormatError);
  expect(() => canonicalize(4.5)).toThrow(UnsupportedFormatError);
  expect(() => canonicalize(Number.MAX_SAFE_INTEGER + 1)).toThrow(UnsupportedFormatError);
  expect(canonicalize(Number.MAX_SAFE_INTEGER)).toBe(String(Number.MAX_SAFE_INTEGER));
  expect(canonicalize(Number.MIN_SAFE_INTEGER)).toBe(String(Number.MIN_SAFE_INTEGER));
});

// Catches: a JCS number written differently from the spec at its edges: -0 is 0; a safe integer is
// never written in exponential form.
test("JCS writes -0 as 0 and a safe integer without an exponent", () => {
  expect(canonicalize(-0)).toBe("0");
  expect(JSON.stringify(-0)).toBe("0");
  expect(canonicalize(-1)).toBe("-1");
  expect(canonicalize(1_000_000_000_000_000)).toBe("1000000000000000");
  // JCS would write 1e21 as 1e+21; it is not a safe integer, so it is refused.
  expect(() => canonicalize(1e21)).toThrow(UnsupportedFormatError);
});

// Catches: locale-aware key ordering, which sorts "B" after "a" in some locales; JCS sorts by UTF-16
// code unit, where every uppercase ASCII letter comes before every lowercase one.
test("keys sort by UTF-16 code unit, not by locale", () => {
  expect(canonicalize({ b: 1, A: 2, a: 3, B: 4, "\u00e9": 5, Z: 6, "0": 7 })).toBe(
    '{"0":7,"A":2,"B":4,"Z":6,"a":3,"b":1,"\u00e9":5}',
  );
  const keys = ["b", "A", "a", "B", "\u00e9", "Z"];
  expect([...keys].sort()).toStrictEqual(["A", "B", "Z", "a", "b", "\u00e9"]);
  expect([...keys].sort((left, right) => left.localeCompare(right, "en"))).not.toStrictEqual(
    [...keys].sort(),
  );
});

// Catches: a string with a lone surrogate reaching UTF-8 as U+FFFD, so two different inputs hash the
// same.
test("a lone surrogate has no canonical form", () => {
  expect(() => canonicalize("\ud800")).toThrow(UnsupportedFormatError);
  expect(() => canonicalize("a\udc00b")).toThrow(UnsupportedFormatError);
  expect(canonicalize("\ud83d\ude00")).toBe('"\ud83d\ude00"');
});

// Catches: undefined, NaN, Infinity, holes, functions, class instances, and cycles being written as
// something stable when they have no JSON form.
test("values with no JSON form are refused", () => {
  expect(() => canonicalize(undefined)).toThrow(UnsupportedFormatError);
  expect(() => canonicalize({ a: undefined })).toThrow(UnsupportedFormatError);
  expect(() => canonicalize([undefined])).toThrow(UnsupportedFormatError);
  expect(() => canonicalize(Number.NaN)).toThrow(UnsupportedFormatError);
  expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(UnsupportedFormatError);
  expect(() => canonicalize(10n)).toThrow(UnsupportedFormatError);
  expect(() => canonicalize(new Date())).toThrow(UnsupportedFormatError);
  const cycle = new Map<unknown, unknown>();
  cycle.set("self", cycle);
  expect(() => canonicalize(cycle)).toThrow(UnsupportedFormatError);
});

// Catches: an argument order leaking into argsHash, so two spellings of one call are judged as two.
test("the same args in another order canonicalize to the same text", async () => {
  const left: ToolCall = {
    v: 1,
    callId: "tool:1:a",
    toolId: "write_file",
    toolVersion: "1",
    args: { path: "a.txt", content: "x", encoding: "utf-8" },
  };
  const right: ToolCall = {
    v: 1,
    callId: "tool:1:a",
    toolId: "write_file",
    toolVersion: "1",
    args: { encoding: "utf-8", content: "x", path: "a.txt" },
  };
  expect(canonicalize(left.args)).toBe(canonicalize(right.args));
  expect(await argsHash(left)).toBe(await argsHash(right));
  expect((await digestCall(left)).callHash).toBe((await digestCall(right)).callHash);
});

const MANIFEST: ToolManifest = {
  v: 1,
  toolId: "write_file",
  version: "1",
  descriptionHash: "0".repeat(64),
  parametersHash: "0".repeat(64),
  risk: "write",
  outputLimits: { maxBytes: 1024, maxLines: 100 },
};

// Catches: a call identity that ignores the tool version (a call judged against v1 running as v2), or
// that changes when an unrelated field does.
test("callHash binds the call id, tool, version, and argsHash only", async () => {
  const call: ToolCall = {
    v: 1,
    callId: "tool:9:z",
    toolId: "read_file",
    toolVersion: "3",
    args: { path: "a.txt" },
  };
  const hashed = await argsHash(call);
  const expected = await sha256Hex(
    canonicalize({
      v: 1,
      callId: "tool:9:z",
      toolId: "read_file",
      toolVersion: "3",
      argsHash: hashed,
    }),
  );
  expect(await callHash(call, hashed)).toBe(expected);
  expect(await callHash({ ...call, toolVersion: "4" }, hashed)).not.toBe(expected);
  expect(await callHash(call, await sha256Hex("{}"))).not.toBe(expected);
  expect(await callHash({ ...call, callId: "tool:9:y" }, hashed)).not.toBe(expected);
});

// Catches: a manifest hash that covers the tool id but not the version, or a policy hash that
// ignores a field.
test("manifestHash and policyHash cover every field of what they name", async () => {
  const hashed = await manifestHash(MANIFEST);
  expect(hashed).toMatch(/^[0-9a-f]{64}$/u);
  expect(await manifestHash({ ...MANIFEST, version: "2" })).not.toBe(hashed);
  expect(await manifestHash({ ...MANIFEST, risk: "exec" })).not.toBe(hashed);
  expect(
    await manifestHash({ ...MANIFEST, outputLimits: { maxBytes: 1, maxLines: 100 } }),
  ).not.toBe(hashed);

  const policy: PolicyDocument = {
    v: 1,
    tools: {
      read_file: {
        enabled: true,
        scope: { kind: "read", roots: ["."] },
        grantTtlSeconds: 60,
        maxCallsPerGrant: 1000,
      },
    },
    egress: { enabled: false, hosts: [] },
  };
  expect(await policyHash(policy)).toMatch(/^[0-9a-f]{64}$/u);
  expect(await policyHash({ ...policy, egress: { enabled: true, hosts: [] } })).not.toBe(
    await policyHash(policy),
  );
});

// Catches: a review token that does not move with the credential that reads it (the same reader is
// bound to the approval) or with the base / candidate it approves.
test("reviewToken is stable and binds the fingerprint, base, and candidate", async () => {
  const input = {
    proposalId: "p1",
    baseHash: await policyHash({ v: 1, tools: {}, egress: { enabled: false, hosts: [] } }),
    candidateHash: "a".repeat(64),
    credentialFingerprint: "",
  };
  const token = await reviewToken(input);
  expect(await reviewToken({ ...input })).toBe(token);
  expect(await reviewToken({ ...input, credentialFingerprint: "fp" })).not.toBe(token);
  expect(await reviewToken({ ...input, candidateHash: "b".repeat(64) })).not.toBe(token);
  expect(await reviewToken({ ...input, proposalId: "p2" })).not.toBe(token);
});

// Catches: a corpus of paths, Unicode, and integers where two inputs collapse or one input moves.
test("callHash is stable per input and changes with every input", async () => {
  const corpus: ReadonlyArray<Readonly<Record<string, unknown>>> = [
    { path: "a/b" },
    { path: "a/b/c" },
    { path: ".." },
    { path: "a/../../etc/passwd" },
    { path: "link-to-outside" },
    { path: "\u00e9t\u00e9/\ud83d\ude00.txt" },
    { path: "\u00e9t\u00e9/\ud83d\ude01.txt" },
    { n: 0 },
    { n: 1 },
    { n: 2 ** 40 },
    { n: -(2 ** 40) },
    { path: "a", n: 1 },
  ];
  const hashes = new Map<string, string>();
  for (const args of corpus) {
    const call: ToolCall = { v: 1, callId: "tool:1:x", toolId: "bash", toolVersion: "1", args };
    const first = await digestCall(call);
    const second = await digestCall(call);
    expect(second).toStrictEqual(first);
    hashes.set(canonicalize(args), first.callHash);
  }
  expect(new Set(hashes.values()).size).toBe(hashes.size);
});
