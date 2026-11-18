import { expect, test } from "vitest";
import { isoTimestamp } from "@hns/core";
import type { CheckpointRecord } from "@hns/core";
import { checkpointPackKey, gitObjectId } from "@hns/workspace/objects";
import { fallbackLine, selectedReviewDiff, type ReviewSelectionDeps } from "./selected.ts";
import { fakeArtifactsReview } from "../../test/support/artifacts-review.ts";
import { artifactsRepoName } from "../artifacts/repos.ts";

/**
 * Which source a review's diff is read from, and what the answer says when it is not Artifacts
 * (0248).
 *
 * @remarks
 * The selector is tested over the two real adapters (`ArtifactsReviewSource` over a fake
 * namespace, `R2ReviewSource` over a bucket in memory) so the order, the fallback sentence, and
 * the machine's absence are proven where production decides them. The record is the Workspace
 * object's `GET /rpc/checkpoint/record` answer, faked here by its JSON.
 */

/** The fixture's commits, calculated by the contract's own hash before anything names them. */
const FIXTURE = await fixtureCommits();
const BASE = FIXTURE[0]?.commit ?? "";
const HEAD = FIXTURE[1]?.commit ?? "";
/** The workspace's repository name, which the selector derives from the Change's workspace id. */
const REPO = artifactsRepoName("workspace-1");

/**
 * The Artifacts namespace over the fixture commits, in the real binding's shape.
 *
 * @returns The namespace; `empty` holds no repository at all, as a workspace that never pushed.
 */
function artifactsNamespace(options: { readonly empty?: boolean } = {}) {
  const binding = fakeArtifactsReview();
  if (options.empty === true) return binding;
  for (const entry of FIXTURE) {
    binding.put(REPO, entry.commit, {
      kind: "commit",
      metadata: {
        hash: entry.commit,
        // The fixture's own tree id: the two commits hold different trees, or the diff is empty.
        treeHash: entry.tree,
        message: "hns checkpoint",
        committedAt: 1_760_000_000,
      },
    });
    binding.put(REPO, entry.tree, {
      kind: "tree",
      entries: [{ name: "a.txt", mode: "100644", hash: entry.blob, type: "blob" }],
    });
    binding.put(REPO, "blob:" + entry.commit + ":a.txt", {
      kind: "blob",
      bytes: new TextEncoder().encode(entry.text),
      type: "text/plain;charset=utf-8",
    });
  }
  return binding;
}
/**
 * A bucket holding the packs it is given.
 *
 * @remarks
 * Only `get` is called by the review source; the rest of the R2 surface is a defect if a review
 * path ever reaches it, so it is spelled as one rather than faked into working.
 */
function bucketOf(
  packs: ReadonlyMap<string, Uint8Array>,
): NonNullable<ReviewSelectionDeps["objects"]> {
  const unreachable = (): never => {
    throw new Error("a review reads a bucket with get only");
  };
  return {
    put: unreachable,
    head: unreachable,
    list: unreachable,
    get: (key) => {
      const bytes = packs.get(key);
      return Promise.resolve(
        bytes === undefined
          ? null
          : { arrayBuffer: async (): Promise<ArrayBuffer> => new Uint8Array(bytes).buffer },
      );
    },
  };
}

/** The Workspace object, faked by the JSON its record route answers. */
function workspaceOf(record: CheckpointRecord | undefined) {
  return {
    fetch: (request: Request): Promise<Response> => {
      const commitId = new URL(request.url).searchParams.get("commit");
      if (record === undefined || record.commit !== commitId) {
        return Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 404 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true, checkpoint: record })));
    },
  };
}

/** A record of one commit and its mirror state. */
function recordOf(status: CheckpointRecord["mirror"]["status"]): CheckpointRecord {
  return {
    runId: "run-1",
    ref: "refs/hns/checkpoints/run-1",
    commit: HEAD,
    packKey: checkpointPackKey(HEAD),
    objectCount: 3,
    packBytes: 100,
    maxBlobBytes: 24,
    mirror: { status, updatedAt: isoTimestamp("2026-11-18T00:00:00.000Z") },
  };
}
/** One fixture commit: its objects and the ids the two stores must agree on. */
interface FixtureCommit {
  readonly commit: string;
  readonly tree: string;
  readonly blob: string;
  readonly text: string;
  readonly objects: readonly {
    readonly type: "blob" | "tree" | "commit";
    readonly content: Uint8Array;
  }[];
}

/**
 * The two commits both stores answer for: a file `a.txt` and one line more at the head.
 *
 * @remarks
 * The ids are calculated with the contract's own hash, so the R2 reader's check that a pack
 * holds the commit its key names is exercised rather than bypassed, and the Artifacts source
 * and the pack name the very same objects.
 */
async function fixtureCommits(): Promise<readonly FixtureCommit[]> {
  const enc = new TextEncoder();
  const made: FixtureCommit[] = [];
  for (const text of ["hi", "hi\nyo"]) {
    const blobObject = { type: "blob" as const, content: enc.encode(text) };
    const blobId = await gitObjectId(blobObject);
    const parts: number[] = [];
    for (const byte of enc.encode("100644 a.txt")) parts.push(byte);
    parts.push(0);
    for (let index = 0; index < 20; index += 1) {
      parts.push(Number.parseInt(blobId.slice(index * 2, index * 2 + 2), 16));
    }
    const treeObject = { type: "tree" as const, content: Uint8Array.from(parts) };
    const treeId = await gitObjectId(treeObject);
    const commitObject = {
      type: "commit" as const,
      content: enc.encode(
        "tree " +
          treeId +
          "\nauthor hns <hns@example.com> 1700000000 +0000\n" +
          "committer hns <hns@example.com> 1700000000 +0000\n\nhns checkpoint",
      ),
    };
    made.push({
      commit: await gitObjectId(commitObject),
      tree: treeId,
      blob: blobId,
      text,
      objects: [blobObject, treeObject, commitObject],
    });
  }
  return made;
}

/** The packs the R2 source reads: one per fixture commit, as a checkpoint uploads. */
async function packs(): Promise<Map<string, Uint8Array>> {
  const stored = new Map<string, Uint8Array>();
  for (const entry of FIXTURE) {
    stored.set(checkpointPackKey(entry.commit), await packOf(entry.objects));
  }
  return stored;
}
/** Build a v2 pack of the objects, with a correct trailer. */
async function packOf(
  objects: readonly { readonly type: "blob" | "tree" | "commit"; readonly content: Uint8Array }[],
): Promise<Uint8Array> {
  const { deflateSync } = await import("node:zlib");
  const { createHash } = await import("node:crypto");
  const typeNumber = { commit: 1, tree: 2, blob: 3 } satisfies Record<string, number>;
  const header = (size: number, type: number): number[] => {
    const groups: number[] = [];
    let rest = Math.floor(size / 16);
    while (rest > 0) {
      groups.push(rest % 128);
      rest = Math.floor(rest / 128);
    }
    const bytes: number[] = [(groups.length > 0 ? 0x80 : 0) | (type << 4) | (size % 16)];
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      bytes.push((index === 0 ? 0 : 0x80) | (groups[index] ?? 0));
    }
    return bytes;
  };
  const body: number[] = [];
  for (const object of objects) {
    body.push(...header(object.content.length, typeNumber[object.type]));
    for (const byte of deflateSync(object.content, { level: 1 })) body.push(byte);
  }
  const prefix = new TextEncoder().encode(
    "PACK" + "\0\0\0\u0002\0\0\0" + String.fromCharCode(objects.length),
  );
  const all = Uint8Array.from([...prefix, ...body]);
  return Uint8Array.from([...all, ...createHash("sha1").update(all).digest()]);
}

/** The selector's inputs, with the Artifacts namespace and the bucket the test gives it. */
function depsOf(options: {
  readonly artifacts?: ReturnType<typeof fakeArtifactsReview> | undefined;
  readonly packs?: ReadonlyMap<string, Uint8Array> | undefined;
  readonly workspace?: CheckpointRecord | undefined;
}): ReviewSelectionDeps {
  return {
    objects: options.packs === undefined ? undefined : bucketOf(options.packs),
    artifacts: options.artifacts,
    workspaceId: "workspace-1",
    workspace: workspaceOf(options.workspace),
    requestId: "selected-test",
  };
}

// Catches: a review that prefers the checkpoint store (the machine) over the mirror, so a
// mirrored Change is read from a store the design says it does not need.
test("C1: a diff both stores hold is read from Artifacts", async () => {
  const stored = await packs();
  const result = await selectedReviewDiff(
    depsOf({ artifacts: artifactsNamespace(), packs: stored, workspace: recordOf("skipped") }),
    BASE,
    HEAD,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.source).toBe("artifacts");
  expect(result.value.mirror).toStrictEqual([]);
  expect(result.value.fallback).toBeNull();
  expect(result.value.diff.files.map((file) => file.path)).toStrictEqual(["a.txt"]);
});

// Catches: a mirror that failed or was skipped read from R2 with nothing said, so a reviewer
// cannot tell the fallback happened.
test("C2: when Artifacts lacks the commit the diff comes from R2 and says why", async () => {
  const stored = await packs();
  for (const [status, word] of [
    ["skipped", "ミラーを skip"],
    ["failed", "ミラーが失敗"],
    ["pending", "まだ完了していない"],
  ] as const) {
    const result = await selectedReviewDiff(
      depsOf({
        artifacts: artifactsNamespace({ empty: true }),
        packs: stored,
        workspace: recordOf(status),
      }),
      BASE,
      HEAD,
    );
    expect(result.ok, status).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe("r2");
    const head = result.value.mirror.find((entry) => entry.side === "head");
    expect(head?.status, status).toBe(status);
    expect(head?.source).toBe("r2");
    expect(result.value.fallback).toContain(word);
    expect(result.value.fallback).toContain("R2 の checkpoint");
  }
});

// Catches: a commit with no recorded checkpoint presented as if its mirror were fine, and the
// stored failure reason dropped from the answer.
test("C2: no record is pending, and a failed record keeps its reason", async () => {
  const stored = await packs();
  const unknown = await selectedReviewDiff(
    depsOf({ artifacts: artifactsNamespace({ empty: true }), packs: stored, workspace: undefined }),
    BASE,
    HEAD,
  );
  expect(unknown.ok).toBe(true);
  if (!unknown.ok) return;
  expect(unknown.value.mirror.map((entry) => entry.status)).toStrictEqual(["pending", "pending"]);
  const failed: CheckpointRecord = {
    ...recordOf("failed"),
    mirror: {
      status: "failed",
      failure: "network",
      updatedAt: isoTimestamp("2026-11-18T00:00:00.000Z"),
    },
  };
  const withReason = await selectedReviewDiff(
    depsOf({ artifacts: artifactsNamespace({ empty: true }), packs: stored, workspace: failed }),
    BASE,
    HEAD,
  );
  expect(withReason.ok).toBe(true);
  if (!withReason.ok) return;
  const head = withReason.value.mirror.find((entry) => entry.side === "head");
  expect(head?.failure).toBe("network");
  expect(head === undefined ? undefined : fallbackLine(head)).toContain("network");
});

// Catches: a review that answers an empty diff, or an R2 read of a commit R2 does not hold, when
// the machine is the only place left. Reading a commit from a machine is not wired yet (0248),
// and the answer must say so rather than pretend.
test("the machine fallback is refused with a typed failure, not answered", async () => {
  const result = await selectedReviewDiff(
    depsOf({
      artifacts: artifactsNamespace({ empty: true }),
      packs: new Map(),
      workspace: recordOf("skipped"),
    }),
    BASE,
    HEAD,
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.failure).toBe("not_found");
  expect(result.message).toContain("machine");
});

// Catches: a deployment with no Artifacts binding and no store answering as if the change had no
// files, and a commit that is not a commit id reaching a store.
test("no source at all is unavailable, and a value that is not a commit id is refused", async () => {
  const none = await selectedReviewDiff(depsOf({}), BASE, HEAD);
  expect(none.ok).toBe(false);
  if (none.ok) return;
  expect(none.failure).toBe("unavailable");
  const refs = await selectedReviewDiff(
    depsOf({ artifacts: artifactsNamespace() }),
    "refs/heads/main",
    HEAD,
  );
  expect(refs.ok).toBe(false);
  if (refs.ok) return;
  expect(refs.failure).toBe("invalid_request");
});
