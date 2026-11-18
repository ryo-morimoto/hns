import { expect, test } from "vitest";
import { isoTimestamp } from "@hns/core";
import { deny } from "@hns/core/capability";
import type { SignedGrant, ToolManifest } from "@hns/core/capability";
import {
  GrantUnavailableError,
  grantCache,
  grantRequestFor,
  sessionGrantPath,
  type GrantAnswer,
  type GrantRequest,
  type GrantSource,
  type ToolContract,
} from "./runtime.ts";

/**
 * The agent's grant cache (0226 C2, C3): one grant per tool × manifest × machine, re-asked only
 * when it can no longer be used.
 *
 * @remarks
 * The issuer is a fake that counts what it was asked; the grants are shaped as the contract's, with
 * a real expiry the clock controls. What is proved is the count, which is the whole point of the
 * cache (`docs/capability.md` §5: a grant per session × tool × manifest × machine, not per call).
 */

const NOW = Date.parse("2026-11-18T00:00:00.000Z");

/** One fake grant with the expiry a test names. */
function grant(id: string, expiresAtMs: number): SignedGrant {
  return {
    payload: {
      v: 1,
      grantId: id,
      workspaceId: "w",
      sessionId: "s",
      machineId: "m",
      toolId: "read_file",
      toolVersion: "1",
      manifestHash: "a".repeat(64),
      scope: { kind: "read", roots: ["."] },
      issuedAt: isoTimestamp("2026-11-18T00:00:00.000Z"),
      expiresAt: isoTimestamp(new Date(expiresAtMs).toISOString()),
      epoch: 1,
      policyHash: "b".repeat(64),
      maxCalls: 10,
      maxBytes: 1024,
      nonce: "n-" + id,
      alg: "Ed25519",
      keyId: "k",
    },
    signature: "s-" + id,
  };
}

/** A source that answers what a test tells it, and counts what it was asked. */
function countingSource(answer: (n: number) => GrantAnswer) {
  const asked: GrantRequest[] = [];
  return {
    asked,
    source: {
      async issue(request: GrantRequest) {
        asked.push(request);
        return answer(asked.length);
      },
    },
  };
}

const MANIFEST: ToolManifest = {
  v: 1,
  toolId: "read_file",
  version: "1",
  descriptionHash: "c".repeat(64),
  parametersHash: "d".repeat(64),
  risk: "read",
  outputLimits: { maxBytes: 4096, maxLines: 100 },
};

const CONTRACT: ToolContract = { manifest: MANIFEST, manifestHash: "a".repeat(64) };

// C2: one grant serves every call until just before its expiry.
test("two calls of one tool ask for one grant", async () => {
  const { source, asked } = countingSource((n) => ({
    ok: true,
    grant: grant("g" + n, NOW + 60_000),
  }));
  const cache = grantCache({ source, now: () => NOW });
  const request = grantRequestFor(CONTRACT);
  const first = await cache.source.issue(request);
  const second = await cache.source.issue(request);
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  if (!first.ok || !second.ok) throw new Error("both calls should have a grant");
  expect(second.grant.payload.grantId).toBe(first.grant.payload.grantId);
  expect(asked).toHaveLength(1);
});

// C2: concurrent first calls share one issuance.
test("calls that miss together share one issuance", async () => {
  const { source, asked } = countingSource((n) => ({
    ok: true,
    grant: grant("g" + n, NOW + 60_000),
  }));
  const cache = grantCache({ source, now: () => NOW });
  const request = grantRequestFor(CONTRACT);
  const [a, b, c] = await Promise.all([
    cache.source.issue(request),
    cache.source.issue(request),
    cache.source.issue(request),
  ]);
  expect([a.ok, b.ok, c.ok]).toStrictEqual([true, true, true]);
  expect(asked).toHaveLength(1);
});

// C3: a grant inside the refresh margin is not reused; the next call asks again.
test("a grant close to its expiry is asked for again", async () => {
  let at = NOW;
  const { source, asked } = countingSource((n) => ({
    ok: true,
    grant: grant("g" + n, at + 60_000),
  }));
  const cache = grantCache({ source, now: () => at });
  const request = grantRequestFor(CONTRACT);
  expect((await cache.source.issue(request)).ok).toBe(true);
  // Past the expiry less the 5-second margin: the grant would not be good for another call.
  at = at + 60_000 - 1_000;
  expect((await cache.source.issue(request)).ok).toBe(true);
  expect(asked).toHaveLength(2);
});

// A refusal is the policy's answer and is not cached: the next call asks again.
test("a refusal is not cached", async () => {
  const { source, asked } = countingSource(() => ({
    ok: false,
    decision: deny("tool_disabled", "off"),
  }));
  const cache = grantCache({ source, now: () => NOW });
  const request = grantRequestFor(CONTRACT);
  const first = await cache.source.issue(request);
  expect(first).toStrictEqual({ ok: false, decision: deny("tool_disabled", "off") });
  await cache.source.issue(request);
  expect(asked).toHaveLength(2);
});

// A dropped grant is asked for again: the machine says why, the cache forgets.
test("clearing the cache makes the next call ask again", async () => {
  const { source, asked } = countingSource((n) => ({
    ok: true,
    grant: grant("g" + n, NOW + 60_000),
  }));
  const cache = grantCache({ source, now: () => NOW });
  const request = grantRequestFor(CONTRACT);
  await cache.source.issue(request);
  cache.clear();
  await cache.source.issue(request);
  expect(asked).toHaveLength(2);
});

// An issuer that throws is "no grant", never "no policy".
test("an issuer that throws is a grant that could not be obtained", async () => {
  const source: GrantSource = {
    issue: async () => {
      throw new Error("the object is asleep");
    },
  };
  const cache = grantCache({ source, now: () => NOW });
  await expect(cache.source.issue(grantRequestFor(CONTRACT))).rejects.toBeInstanceOf(
    GrantUnavailableError,
  );
  await expect(cache.source.issue(grantRequestFor(CONTRACT))).rejects.toThrow(
    "the issuer could not be asked: Error",
  );
});

// The grant's expiry is the cache's clock; an unreadable expiry is not a cached grant.
test("a grant with no readable expiry is not cached", async () => {
  const broken: SignedGrant = {
    ...grant("g", NOW + 60_000),
    // A grant whose expiry is not a time the cache can read: the type is the contract's, so a
    // value that is not one arrives from an issuer that broke it, and the cache refuses to hold it.
    // SAFETY: the broken value is the subject: an issuer that signed a grant with an unreadable
    // expiry, which the type promises cannot happen. The cache must refuse to hold it.
    payload: { ...grant("g", NOW + 60_000).payload, expiresAt: "not a time" as never },
  };
  const { source, asked } = countingSource(() => ({ ok: true, grant: broken }));
  const cache = grantCache({ source, now: () => NOW });
  await expect(cache.source.issue(grantRequestFor(CONTRACT))).rejects.toBeInstanceOf(
    GrantUnavailableError,
  );
  expect(asked).toHaveLength(1);
});

// A grant the machine refused as expired is dropped: the next call asks for a fresh one (C3).
test("a grant the machine refused as expired is asked for again", async () => {
  let asked = 0;
  const source: GrantSource = {
    async issue() {
      asked += 1;
      return { ok: true, grant: grant("g" + String(asked), NOW + 60_000) };
    },
  };
  const answers = deny("grant_expired", "the grant is not valid at this time");
  const transportCalls: string[] = [];
  const path = sessionGrantPath({
    source,
    now: () => NOW,
    transport: {
      async call(input) {
        transportCalls.push(input.grant.payload.grantId);
        return { decision: answers };
      },
      async closeRun() {
        // The run's end is the cache's to forget; nothing else to end here.
      },
    },
  });
  const request = grantRequestFor(CONTRACT);
  const first = await path.source.issue(request);
  if (!first.ok) throw new Error("the first grant should exist");
  await path.transport.call({
    call: { v: 1, callId: "tool:1:a", toolId: "read_file", toolVersion: "1", args: { path: "a" } },
    contract: CONTRACT,
    bytes: 1,
    grant: first.grant,
  });
  const second = await path.source.issue(request);
  if (!second.ok) throw new Error("the second grant should exist");
  // The expired grant was dropped: the second request asked the issuer again.
  expect(asked).toBe(2);
  expect(second.grant.payload.grantId).not.toBe(first.grant.payload.grantId);
  expect(transportCalls).toStrictEqual([first.grant.payload.grantId]);
});

// The request names the contract and the manifest's output ceiling (what the grant's bytes bound).
test("the request names the tool, its version, its manifest hash, and the manifest's byte bound", () => {
  expect(grantRequestFor(CONTRACT)).toStrictEqual({
    toolId: "read_file",
    toolVersion: "1",
    manifestHash: "a".repeat(64),
    maxBytes: 4096,
  });
});
