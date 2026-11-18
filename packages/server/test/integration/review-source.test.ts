import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import { isoTimestamp } from "@hns/core";
import type { CheckpointRecord, JsonValue } from "@hns/core";
import { toGlobalId } from "@hns/core/graphql";
import type { Store } from "@hns/store";
import { checkpointPackKey, gitObjectId } from "@hns/workspace/objects";
import type { ObjectBody, ObjectMetadata } from "@hns/workspace/objects";
import { createD1Harness, type D1Harness } from "../../../store/test/integration/harness.ts";
import { createGraphQLFace, type GraphQLFaceDependencies } from "../../src/graphql/handler.ts";
import { policyFaceOver } from "../../src/graphql/policy/face.ts";
import { Workspace } from "../../src/do/workspace.ts";
import { artifactsRepoName } from "../../src/artifacts/repos.ts";
import type { WorkerEnv } from "../../src/edge/env.ts";
import { envWith } from "../support/edge.ts";
import { openSqliteState, type OpenSqliteState } from "../support/sqlite.ts";
import { fakeArtifactsReview } from "../support/artifacts-review.ts";
/**
 * Which store a review's diff was read from (0248), over the production parts (C1-C3).
 *
 * @remarks
 * The real GraphQL face (`createGraphQLFace`), the real store (D1 with migration 0010), the real
 * selector (`review/selected.ts`), the real `R2ReviewSource` and `ArtifactsReviewSource`, and the
 * real `Workspace` Durable Object answering `GET /rpc/checkpoint/record`. What is a fake is only
 * the two stores' **bytes**: a `FakeReviewSource` behind the Artifacts repository handle, and a
 * pack built here behind the R2 bucket. The selection path itself is not replaced anywhere.
 *
 * **C1** is a Change whose mirror is `skipped` in the Workspace record and whose bytes are not in
 * the fake bucket: the diff comes out of Artifacts, so the machine (R2) is not needed. **C2** is
 * a mirror that `failed`: the diff is read from R2 and the answer carries the fallback sentence.
 * **C3** is a commit id whose tree and file bytes are the same whichever store answers.
 */

/** The commits the suite reads; {@link commits} builds them in `beforeAll`. */
let BASE = "";
let HEAD = "";
const HUMAN = "owner";
const WORKSPACE = "workspace-review";

/** The two sides of the Change: a one-line file and the same file with a second line. */
const SIDES = [
  { path: "app.ts", text: "const a = 1;\n", message: "hns checkpoint base" },
  { path: "app.ts", text: "const a = 1;\nconst b = 2;\n", message: "hns checkpoint head" },
] as const;

/** One commit's objects, made by the builder both fixtures share. */
interface FixtureCommit {
  readonly commit: string;
  readonly tree: string;
  readonly blob: string;
  readonly path: string;
  readonly text: string;
  readonly objects: readonly GitObject[];
}

/**
 * The commits, by hash: the same objects the Artifacts fake answers and the packs carry.
 *
 * @remarks
 * The ids are **calculated**, not spelled: `gitObjectId` is the contract's own hash, so the R2
 * reader's check that a pack holds the commit its key names is exercised rather than bypassed.
 */
async function commits(): Promise<readonly FixtureCommit[]> {
  const enc = new TextEncoder();
  const made: FixtureCommit[] = [];
  for (const side of SIDES) {
    const blob: GitObject = { type: "blob", content: enc.encode(side.text) };
    const blobId = await gitObjectId(blob);
    const tree = treeObject([{ mode: "100644", name: side.path, id: blobId }]);
    const treeId = await gitObjectId(tree);
    const commit: GitObject = {
      type: "commit",
      content: enc.encode(
        "tree " +
          treeId +
          "\nauthor hns <hns@example.com> 1700000000 +0000\n" +
          "committer hns <hns@example.com> 1700000000 +0000\n\n" +
          side.message,
      ),
    };
    made.push({
      commit: await gitObjectId(commit),
      tree: treeId,
      blob: blobId,
      path: side.path,
      text: side.text,
      objects: [blob, tree, commit],
    });
  }
  return made;
}

/** The workspace whose Artifacts repository the review reads. */
const REPO = artifactsRepoName(WORKSPACE);

/** The R2 packs over the same commits: one pack per commit, as a checkpoint uploads. */
async function r2Packs(made: readonly FixtureCommit[]): Promise<Map<string, Uint8Array>> {
  const packs = new Map<string, Uint8Array>();
  for (const entry of made) packs.set(checkpointPackKey(entry.commit), await packOf(entry.objects));
  return packs;
}
/** One object as the pack builder takes it. */
interface GitObject {
  readonly type: "blob" | "tree" | "commit";
  readonly content: Uint8Array;
}

/** A git tree object from `(mode, name, id)` entries, in the order given. */
function treeObject(entries: readonly { mode: string; name: string; id: string }[]): GitObject {
  const parts: number[] = [];
  for (const entry of entries) {
    for (const byte of new TextEncoder().encode(entry.mode + " " + entry.name)) parts.push(byte);
    parts.push(0);
    for (let index = 0; index < 20; index += 1) {
      parts.push(Number.parseInt(entry.id.slice(index * 2, index * 2 + 2), 16));
    }
  }
  return { type: "tree", content: Uint8Array.from(parts) };
}

/** Build a v2 pack of the objects, with a correct trailer. */
async function packOf(objects: readonly GitObject[]): Promise<Uint8Array> {
  const { deflateSync } = await import("node:zlib");
  const typeNumber: Readonly<Record<GitObject["type"], number>> = { commit: 1, tree: 2, blob: 3 };
  const header = (size: number, type: number): number[] => {
    const groups: number[] = [];
    let rest = Math.floor(size / 16);
    while (rest > 0) {
      groups.push(rest % 128);
      rest = Math.floor(rest / 128);
    }
    const first = (groups.length > 0 ? 0x80 : 0) | (type << 4) | (size % 16);
    const bytes = [first];
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      bytes.push((index === 0 ? 0 : 0x80) | (groups[index] ?? 0));
    }
    return bytes;
  };
  const body: number[] = [];
  for (const object of objects) {
    body.push(...header(object.content.length, typeNumber[object.type]));
    // SAFETY: zlib's deflateSync answers a Buffer, which is a Uint8Array; every element is a
    // byte, so pushing it into a number[] is the same bytes as a plain array.
    for (const byte of deflateSync(object.content, { level: 1 })) body.push(byte);
  }
  const prefix = new TextEncoder().encode(
    "PACK" + "\0\0\0\u0002\0\0\0" + String.fromCharCode(objects.length),
  );
  const all = Uint8Array.from([...prefix, ...body]);
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha1").update(all).digest();
  return Uint8Array.from([...all, ...digest]);
}
/** A bucket that answers the packs it holds, and null for a key it does not. */
class PackBucket {
  readonly #stored: Map<string, Uint8Array>;

  constructor(stored: ReadonlyMap<string, Uint8Array>) {
    this.#stored = new Map(stored);
  }

  async get(key: string): Promise<ObjectBody | null> {
    const bytes = this.#stored.get(key);
    if (bytes === undefined) return null;
    return { arrayBuffer: async (): Promise<ArrayBuffer> => new Uint8Array(bytes).buffer };
  }

  head(key: string): Promise<ObjectMetadata | null> {
    const bytes = this.#stored.get(key);
    return Promise.resolve(bytes === undefined ? null : { key, size: bytes.length });
  }

  put(key: string, value: Uint8Array): Promise<ObjectMetadata> {
    this.#stored.set(key, new Uint8Array(value));
    return Promise.resolve({ key, size: value.byteLength });
  }

  async list(): Promise<{
    readonly objects: readonly ObjectMetadata[];
    readonly truncated: boolean;
  }> {
    return {
      objects: [...this.#stored.keys()].map((key) => ({
        key,
        size: this.#stored.get(key)?.length ?? 0,
      })),
      truncated: false,
    };
  }
}

/**
 * The Artifacts namespace over the fixture commits, in the real binding's shape.
 *
 * @remarks
 * `get` throws `NOT_FOUND` for a workspace whose repository does not exist (a namespace that never
 * pushed), and the handle reads by object id and answers a `Blob` — the same surface the Worker's
 * `env.ARTIFACTS` has, so the production selector and adapter run unmodified against it. The
 * fake satisfies the adapter's binding interface by type, and the environment's binding is that
 * adapter interface, so no assertion stands between them.
 */
function artifactsOver(made: readonly FixtureCommit[], pushed: boolean) {
  const binding = fakeArtifactsReview();
  if (!pushed) return binding;
  for (const entry of made) {
    binding.put(REPO, entry.commit, {
      kind: "commit",
      metadata: {
        hash: entry.commit,
        treeHash: entry.tree,
        message: "hns checkpoint",
        committedAt: 1_760_000_000,
      },
    });
    binding.put(REPO, entry.tree, {
      kind: "tree",
      entries: [{ name: entry.path, mode: "100644", hash: entry.blob, type: "blob" }],
    });
    binding.put(REPO, "blob:" + entry.commit + ":" + entry.path, {
      kind: "blob",
      bytes: new TextEncoder().encode(entry.text),
      type: "text/plain;charset=utf-8",
    });
  }
  return binding;
}
/** A JSON string field as text, or the empty string when it is not one (the assertion then says so). */
function textOfValue(value: JsonValue | undefined): string {
  return v.safeParse(v.string(), value).success ? String(value) : "";
}

/** A Workspace object as the GraphQL context reaches it: one namespace, named by workspace. */
function workspaceNamespace(workspace: Workspace) {
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({ fetch: (request: Request) => workspace.fetch(request) }),
  };
  return namespace satisfies NonNullable<WorkerEnv["WORKSPACE"]>;
}
let harness: D1Harness;
/** The commits once, and the two ids the Changes name. */
let made: readonly FixtureCommit[];

beforeAll(async () => {
  harness = await createD1Harness();
  made = await commits();
  const base = made[0];
  const head = made[1];
  if (base === undefined || head === undefined) throw new Error("the fixture has two commits");
  BASE = base.commit;
  HEAD = head.commit;
});

afterAll(async () => {
  await harness.dispose();
});

/** The Trail detail read the web app ships, plus the store fields this suite needs. */
const DETAIL = `query ReviewSourceDetail($id: ID!) {
  trail(id: $id) {
    __typename
    ... on TrailPayload {
      trail {
        id
        changes {
          id
          workspaceId
          baseCommit
          headCommit
          diff {
            __typename
            ... on ReviewDiff {
              baseCommit
              headCommit
              added
              removed
              source
              fallback
              mirror { side commit status failure source }
              files { path change added removed previewable hunks { baseStart headStart lines { kind text } } }
            }
            ... on QueryFailure { code message }
          }
        }
      }
    }
    ... on QueryFailure { code message }
  }
}`;

const JsonObjectSchema = v.record(v.string(), v.unknown());

/* oxlint-disable anti-slop/no-unknown-parameters --
   Every parsed body and field is `unknown` until this parse checks it; that is its purpose.
*/
function isRecord(value: unknown): value is { readonly [key: string]: JsonValue } {
  /* oxlint-enable anti-slop/no-unknown-parameters */
  return v.safeParse(JsonObjectSchema, value).success;
}

/** The `changes` list of the Trail the detail read answered. */
function changesOf(data: JsonValue): readonly { readonly [key: string]: JsonValue }[] {
  const body: unknown = data;
  const trail = isRecord(body) ? body["trail"] : undefined;
  if (!isRecord(trail)) throw new Error("no trail in " + JSON.stringify(data));
  if (trail["__typename"] === "QueryFailure") throw new Error(String(trail["message"]));
  const found = trail["trail"];
  if (!isRecord(found)) throw new Error("no payload trail");
  const changes = found["changes"];
  if (!Array.isArray(changes)) throw new Error("no changes");
  return changes.map((change) => {
    if (!isRecord(change)) throw new Error("a change is not an object");
    return change;
  });
}

/** The diff of the first Change, which this suite's fixtures each create exactly one of. */
function diffOf(changes: readonly { readonly [key: string]: JsonValue }[]): {
  readonly [key: string]: JsonValue;
} {
  const first = changes[0];
  const diff = first === undefined ? undefined : first["diff"];
  if (!isRecord(diff)) throw new Error("no diff");
  return diff;
}

/** A store with one Trail and one Change between `base` and `head`. */
async function trailWithChange(store: Store, base: string, head: string): Promise<string> {
  const project = await store.projects.create("review-source", "projects/review-source");
  const trail = await store.trails.create({
    projectId: project.id,
    title: "Which store read this?",
    description: "",
    acceptance: "",
    createdBy: HUMAN,
  });
  if (trail.refused) throw new Error("the trail was refused");
  const change = await store.trails.addChange(trail.id, {
    workspaceId: WORKSPACE,
    baseCommit: base,
    headCommit: head,
  });
  if (change.refused) throw new Error("the change was refused: " + change.kind);
  return toGlobalId("Trail", trail.id);
}

/** What the suite's one face is built with, per test. */
interface FaceOptions {
  readonly store: Store;
  readonly packs: ReadonlyMap<string, Uint8Array>;
  /** Whether the workspace's Artifacts repository holds the commits; false is a namespace that never pushed. */
  readonly artifacts: boolean;
  readonly workspace: Workspace | undefined;
}

/**
 * Run the detail read through the production face, over the production selector and sources.
 *
 * @remarks
 * **No read is replaced.** `reads.reviewDiff` is not passed, so `createContext` builds the
 * production one over `env.OBJECTS`, `env.ARTIFACTS`, and `env.WORKSPACE`; only those three
 * values are the suite's (a bucket in memory, a fake namespace, a real object with a real SQLite
 * state). The project lookup is the real store's, and the policy face is the real one over the
 * same store.
 */
async function readDetail(
  options: FaceOptions,
  trailGlobal: string,
): Promise<readonly { readonly [key: string]: JsonValue }[]> {
  const face = createGraphQLFace({
    reads: { project: (projectId) => options.store.projects.get(projectId) },
    policy: policyFaceOver(options.store, { bashSandbox: false }),
  } satisfies GraphQLFaceDependencies);
  const base =
    options.workspace === undefined
      ? envWith({ db: harness.db })
      : envWith({ db: harness.db, workspace: workspaceNamespace(options.workspace) });
  // A separate statement, not a conditional spread: a binding is added only when it exists
  // (`exactOptionalPropertyTypes` makes a present `undefined` a different thing from absent).
  const env: WorkerEnv = options.artifacts
    ? {
        ...base,
        OBJECTS: new PackBucket(options.packs),
        ARTIFACTS: artifactsOver(made, true),
      }
    : { ...base, OBJECTS: new PackBucket(options.packs) };
  const response = await face({
    request: new Request("https://hns.test/graphql", { method: "POST" }),
    env,
    session: { subject: HUMAN, expiresAt: 0 },
    requestId: "review-source",
    signal: new AbortController().signal,
    body: JSON.stringify({ query: DETAIL, variables: { id: trailGlobal } }),
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const body: unknown = JSON.parse(text);
  const data = isRecord(body) ? body["data"] : undefined;
  if (data === undefined) throw new Error("no data in " + text);
  return changesOf(data);
}

/** The Workspace object with a recorded checkpoint of one commit and one mirror state. */
interface Recorded {
  readonly workspace: Workspace;
  readonly sql: OpenSqliteState;
}

/**
 * A Workspace object whose `checkpoint_run` row records one commit.
 *
 * @remarks
 * The row is what the Workspace writes on a complete (0245); this suite starts after that hop,
 * so the record is written through the object's own SQLite schema exactly as `complete` writes
 * it. The object still answers `GET /rpc/checkpoint/record` itself, which is the part under test.
 */
function recorded(record: CheckpointRecord): Recorded {
  const opened = openSqliteState();
  const workspace = new Workspace(opened.state, {});
  opened.sql(
    "CREATE TABLE IF NOT EXISTS checkpoint_run (run_id TEXT PRIMARY KEY, prepare TEXT NOT NULL, record TEXT)",
  );
  opened.sql(
    "INSERT INTO checkpoint_run (run_id, prepare, record) VALUES (?, ?, ?)",
    record.runId,
    "{}",
    JSON.stringify(record),
  );
  return { workspace, sql: opened };
}

/** The record of one commit, with its mirror state. */
function recordOf(
  id: string,
  status: CheckpointRecord["mirror"]["status"],
  failure?: CheckpointRecord["mirror"]["failure"],
): CheckpointRecord {
  return {
    runId: "run-" + id.slice(0, 7),
    ref: "refs/hns/checkpoints/run-" + id.slice(0, 7),
    commit: id,
    packKey: checkpointPackKey(id),
    objectCount: 3,
    packBytes: 100,
    maxBlobBytes: 24,
    mirror:
      failure === undefined
        ? { status, updatedAt: isoTimestamp("2026-11-18T00:00:00.000Z") }
        : { status, failure, updatedAt: isoTimestamp("2026-11-18T00:00:00.000Z") },
  };
}
// C1: Catches a review that needs the checkpoint store (the machine) for a Change the mirror
// already holds: the bucket is empty, so only the Artifacts source can answer at all.
test("C1: a mirrored commit is read from Artifacts with no checkpoint pack in the store", async () => {
  const held = recorded(recordOf(HEAD, "mirrored"));
  try {
    await harness.withStore(async (store) => {
      const trail = await trailWithChange(store, BASE, HEAD);
      const changes = await readDetail(
        { store, packs: new Map(), artifacts: true, workspace: held.workspace },
        trail,
      );
      const diff = diffOf(changes);
      expect(diff["__typename"], JSON.stringify(diff)).toBe("ReviewDiff");
      expect(diff["source"]).toBe("ARTIFACTS");
      expect(diff["mirror"]).toStrictEqual([]);
      expect(diff["fallback"]).toBeNull();
      const files = diff["files"];
      expect(Array.isArray(files)).toBe(true);
      if (!Array.isArray(files)) return;
      expect(files.map((entry) => (isRecord(entry) ? entry["path"] : ""))).toStrictEqual([
        "app.ts",
      ]);
    });
  } finally {
    held.sql.close();
  }
});

// C2: Catches a failed mirror that still shows the diff as if Artifacts had it, and a fallback
// the screen could not see: the record says `failed`, the bytes are only in the store, and the
// answer must say both.
test("C2: a failed mirror is read from the checkpoint store and says so", async () => {
  const packs = await r2Packs(made);
  const failed = recorded(recordOf(HEAD, "failed", "network"));
  try {
    await harness.withStore(async (store) => {
      const trail = await trailWithChange(store, BASE, HEAD);
      const changes = await readDetail(
        // The Artifacts namespace holds nothing: the commit never landed there.
        {
          store,
          packs,
          artifacts: false,
          workspace: failed.workspace,
        },
        trail,
      );
      const diff = diffOf(changes);
      expect(diff["source"]).toBe("R2");
      const mirror = diff["mirror"];
      expect(Array.isArray(mirror)).toBe(true);
      if (!Array.isArray(mirror)) return;
      const head = mirror.find((entry) => isRecord(entry) && entry["side"] === "HEAD");
      expect(head).toBeDefined();
      expect(isRecord(head) ? head["status"] : undefined).toBe("FAILED");
      expect(isRecord(head) ? head["failure"] : undefined).toBe("network");
      expect(isRecord(head) ? head["source"] : undefined).toBe("R2");
      const sentence = textOfValue(diff["fallback"]);
      expect(sentence).toContain("ミラーが失敗した");
      expect(sentence).toContain("network");
      expect(sentence).toContain("R2 の checkpoint");
    });
  } finally {
    failed.sql.close();
  }
});

// C3: Catches a source that reads a ref rather than the commit id: the two stores must answer
// the same tree and the same bytes for the same id, whether or not a ref points at it.
test("C3: both stores read the same tree and file bytes for a commit id", async () => {
  const packs = await r2Packs(made);
  await harness.withStore(async (store) => {
    const trail = await trailWithChange(store, BASE, HEAD);
    const fromArtifacts = diffOf(
      await readDetail({ store, packs: new Map(), artifacts: true, workspace: undefined }, trail),
    );
    const fromR2 = diffOf(
      await readDetail(
        {
          store,
          packs,
          artifacts: false,
          workspace: undefined,
        },
        trail,
      ),
    );
    expect(fromArtifacts["source"]).toBe("ARTIFACTS");
    expect(fromR2["source"]).toBe("R2");
    // The files, hunks, and lines are the commit's, not the store's.
    expect(fromR2["files"]).toStrictEqual(fromArtifacts["files"]);
    expect(fromR2["added"]).toBe(fromArtifacts["added"]);
    expect(fromR2["removed"]).toBe(fromArtifacts["removed"]);
  });
});
