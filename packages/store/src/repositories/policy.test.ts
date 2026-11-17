import { migrateStore } from "../migrate.ts";
import type { PolicyDocument, PolicyRevision } from "@hns/core/capability";
import { policyHash } from "@hns/core/capability";
import { isoTimestamp } from "@hns/core";
import { beforeEach, describe, expect, test } from "vitest";
import { openFakeD1, type FakeD1 } from "../../../server/test/support/d1.ts";
import { clock, counter } from "../../test/support.ts";
import { policyRepository, type PolicyRepository, type PolicySeed } from "./policy.ts";
import { createContext } from "../db.ts";
import { createSql } from "../sql.ts";

const WORKSPACE = "ws-1";

/** A document the baseline does not have: one extra egress host. */
const CANDIDATE: PolicyDocument = {
  v: 1,
  tools: {},
  egress: { enabled: true, hosts: [{ host: "api.example", port: 443 }] },
};

let fake: FakeD1;
let policy: PolicyRepository;

beforeEach(async () => {
  fake = openFakeD1();
  await migrateStore(fake.db);
  policy = policyRepository(createContext(createSql(fake.db), { now: clock(), newId: counter() }));
});

/** The seed a first `ensure` writes. */
async function seed(): Promise<PolicySeed> {
  const document: PolicyDocument = { v: 1, tools: {}, egress: { enabled: false, hosts: [] } };
  return {
    document,
    hash: await policyHash(document),
    createdAt: isoTimestamp("2026-01-01T00:00:00.000Z"),
    createdBy: "system",
  };
}

/** A revision row a test can store directly. */
async function revisionAt(at: number, document: PolicyDocument): Promise<PolicyRevision> {
  return {
    workspaceId: WORKSPACE,
    revision: at,
    hash: await policyHash(document),
    document,
    createdAt: isoTimestamp("2026-01-02T00:00:00.000Z"),
    createdBy: "human-1",
  };
}

describe("the policy rows in real SQLite", () => {
  // Catches: a seed that writes revision 1 twice, or a second call that reads a different row.
  test("ensure stores revision 1 once and returns the same revision twice", async () => {
    const first = await policy.ensure(WORKSPACE, await seed());
    expect(first.revision).toBe(1);
    const second = await policy.ensure(WORKSPACE, await seed());
    expect(second).toStrictEqual(first);
    expect((await policy.revisions(WORKSPACE)).length).toBe(1);
    expect(await policy.active(WORKSPACE)).toStrictEqual({
      workspaceId: WORKSPACE,
      revision: 1,
      hash: first.hash,
      updatedAt: first.createdAt,
    });
  });

  // Catches: an ON CONFLICT that overwrites the row a first caller wrote.
  test("a second ensure keeps the document the first one wrote", async () => {
    const first = await seed();
    await policy.ensure(WORKSPACE, first);
    const other = await policyHash(CANDIDATE);
    const second = await policy.ensure(WORKSPACE, { ...first, document: CANDIDATE, hash: other });
    expect(second.document).toStrictEqual(first.document);
    expect(second.hash).toBe(first.hash);
  });

  // Catches: a compare-and-swap that moves the pointer whatever revision is active.
  test("activate moves the pointer only while the base revision is active", async () => {
    await policy.ensure(WORKSPACE, await seed());
    const next = await revisionAt(2, CANDIDATE);
    await policy.append(next);
    expect(
      await policy.activate({
        workspaceId: WORKSPACE,
        baseRevision: 2,
        revision: 2,
        hash: next.hash,
      }),
    ).toBe(false);
    expect((await policy.active(WORKSPACE))?.revision).toBe(1);
    expect(
      await policy.activate({
        workspaceId: WORKSPACE,
        baseRevision: 1,
        revision: 2,
        hash: next.hash,
      }),
    ).toBe(true);
    const active = await policy.active(WORKSPACE);
    expect(active?.revision).toBe(2);
    expect(active?.hash).toBe(next.hash);
  });

  // Catches: an append that replaces a stored revision.
  test("a revision is append-only: the same number cannot be written twice", async () => {
    await policy.ensure(WORKSPACE, await seed());
    const next = await revisionAt(2, CANDIDATE);
    expect(await policy.append(next)).toBe(true);
    expect(
      await policy.append({
        ...next,
        document: { v: 1, tools: {}, egress: { enabled: false, hosts: [] } },
      }),
    ).toBe(false);
    expect((await policy.revision(WORKSPACE, 2))?.document).toStrictEqual(CANDIDATE);
  });

  test("a proposal keeps its pending status until a decision, and only a pending one moves", async () => {
    const created = await policy.createProposal({
      id: "p-1",
      workspaceId: WORKSPACE,
      baseRevision: 1,
      baseHash: "a".repeat(64),
      candidate: CANDIDATE,
      candidateHash: "b".repeat(64),
      reviewToken: "c".repeat(64),
      requestedBy: "agent-1",
      reason: "reach one host",
    });
    expect(created.status).toBe("pending");
    expect(created.updatedAt).toBe(created.createdAt);
    expect(created.decidedBy).toBeUndefined();
    expect(
      await policy.decideProposal({
        id: "p-1",
        status: "approved",
        decidedBy: "human-1",
        decidedAt: isoTimestamp("2026-01-03T00:00:00.000Z"),
        decisionReason: "ok",
      }),
    ).toBe("updated");
    const decided = await policy.proposal("p-1");
    expect(decided?.status).toBe("approved");
    expect(decided?.decidedBy).toBe("human-1");
    expect(
      await policy.decideProposal({
        id: "p-1",
        status: "rejected",
        decidedBy: "human-2",
        decidedAt: isoTimestamp("2026-01-04T00:00:00.000Z"),
        decisionReason: "no",
      }),
    ).toBe("not_pending");
    expect((await policy.proposal("p-1"))?.decidedBy).toBe("human-1");
    expect(
      await policy.decideProposal({
        id: "missing",
        status: "rejected",
        decidedBy: "human-1",
        decidedAt: isoTimestamp("2026-01-04T00:00:00.000Z"),
        decisionReason: "no",
      }),
    ).toBe("missing");
  });

  test("proposals are listed newest first, and by status", async () => {
    const base = {
      workspaceId: WORKSPACE,
      baseRevision: 1,
      baseHash: "a".repeat(64),
      candidate: CANDIDATE,
      candidateHash: "b".repeat(64),
      reviewToken: "c".repeat(64),
      requestedBy: "agent-1",
      reason: "r",
    };
    await policy.createProposal({ ...base, id: "p-1" });
    await policy.createProposal({ ...base, id: "p-2" });
    await policy.decideProposal({
      id: "p-1",
      status: "rejected",
      decidedBy: "human-1",
      decidedAt: isoTimestamp("2026-01-03T00:00:00.000Z"),
      decisionReason: "no",
    });
    expect((await policy.proposals(WORKSPACE)).map((p) => p.id)).toStrictEqual(["p-2", "p-1"]);
    expect((await policy.proposals(WORKSPACE, "pending")).map((p) => p.id)).toStrictEqual(["p-2"]);
  });

  // Catches: a status column with no CHECK, which would let a hand-edited row invent a state.
  test("the table refuses an unknown proposal status", async () => {
    expect(() =>
      fake.exec(
        "INSERT INTO policy_proposals (id, workspace_id, base_revision, base_hash, " +
          "candidate_json, candidate_hash, review_token, requested_by, reason, status, " +
          "created_at, updated_at) VALUES ('p', 'ws', 1, 'a', '{}', 'b', 'c', 'd', 'e', " +
          "'approved-elsewhere', 'now', 'now')",
      ),
    ).toThrow();
  });

  // Catches: a row whose document this build cannot parse being returned half-read.
  test("a revision whose document does not parse fails the read", async () => {
    fake.exec(
      "INSERT INTO policy_revisions (workspace_id, revision, hash, document_json, created_at, created_by) " +
        "VALUES ('ws-1', 1, '" +
        "a".repeat(64) +
        '\', \'{"v":1,"tools":{"read_file":{"enabled":true,"scope":{"kind":"glob"},"grantTtlSeconds":60,"maxCallsPerGrant":1}},"egress":{"enabled":false,"hosts":[]}}\', ' +
        "'2026-01-01T00:00:00.000Z', 'system')",
    );
    await expect(policy.revision(WORKSPACE, 1)).rejects.toThrow();
  });
});
