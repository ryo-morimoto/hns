import { expect, expectTypeOf, test } from "vitest";
import { isoTimestamp } from "@hns/core";
import type { ReviewCommit, ReviewFile, ReviewTreeEntry } from "@hns/core";
import { artifactsRepoName } from "../artifacts/repos.ts";
import {
  ArtifactsReviewSource,
  type ArtifactsReviewBinding,
  type ArtifactsReviewHandle,
} from "./artifacts.ts";
import { ReviewSourceError, type ReviewSource } from "./source.ts";
/**
 * C3: the Artifacts source reads by commit id, and the bytes are the commit's own (0248).
 *
 * @remarks
 * The binding is a fake here; what is proved is the **adapter's contract** — that a commit id is
 * what travels, never a ref name — that the three calls answer the port's values, and that each
 * binding failure becomes one code of the closed `ReviewFailure` vocabulary. The fake has the
 * shape Artifacts' repository handle has after `get`, which is what the real binding supplies.
 */

const HEAD = "b".repeat(40);
const BASE = "a".repeat(40);
const TREE = "c".repeat(40);
const BLOB = "d".repeat(40);
const REPO = artifactsRepoName("workspace-1");

/** An error shaped like the binding's `ArtifactsError`, carrying one of its codes. */
function artifactError(code: string): Error {
  const error = new Error("artifacts: " + code);
  error.name = "ArtifactsError";
  // SAFETY: the fake builds the error itself; `code` is the one property it adds to an Error.
  (error as Error & { code: string }).code = code;
  return error;
}

/** What the fake repository keeps, and every call it saw. */
interface FakeRepository {
  readonly commits: Map<string, { tree: string; message: string; committedAt: string }>;
  readonly trees: Map<string, readonly unknown[]>;
  readonly files: Map<string, { object: string; bytes: Uint8Array }>;
  readonly calls: string[];
  readonly failures: Map<string, Error>;
}

/** A namespace over one repository, shaped like the Worker's `ARTIFACTS.get`. */
function bindingOf(
  repo: FakeRepository,
): ArtifactsReviewBinding & { get(name: string): Promise<ArtifactsReviewHandle | null> } {
  const handle: ArtifactsReviewHandle = {
    log: (commit) => {
      repo.calls.push("log " + commit);
      const failure = repo.failures.get("log");
      if (failure !== undefined) {
        repo.failures.delete("log");
        return Promise.reject(failure);
      }
      const commitValue = repo.commits.get(commit);
      if (commitValue === undefined) return Promise.reject(artifactError("NOT_FOUND"));
      return Promise.resolve({ commit, ...commitValue });
    },
    readTree: (input) => {
      repo.calls.push("readTree " + input.commit + ":" + input.path);
      const failure = repo.failures.get("readTree");
      if (failure !== undefined) {
        repo.failures.delete("readTree");
        return Promise.reject(failure);
      }
      const entries = repo.trees.get(input.commit + ":" + input.path);
      if (entries === undefined) return Promise.reject(artifactError("NOT_FOUND"));
      return Promise.resolve(entries);
    },
    readFile: (input) => {
      repo.calls.push("readFile " + input.commit + ":" + input.path);
      const failure = repo.failures.get("readFile");
      if (failure !== undefined) {
        repo.failures.delete("readFile");
        return Promise.reject(failure);
      }
      const file = repo.files.get(input.commit + ":" + input.path);
      if (file === undefined) return Promise.reject(artifactError("NOT_FOUND"));
      return Promise.resolve({ path: input.path, ...file });
    },
  };
  return {
    get: (name) => {
      repo.calls.push("get " + name);
      return Promise.resolve(name === REPO ? handle : null);
    },
  };
}

/** The repository a review of the base and head reads. */
function repository(): FakeRepository {
  const repo: FakeRepository = {
    commits: new Map([
      [
        BASE,
        { tree: TREE, message: "hns checkpoint base", committedAt: "2026-11-18T00:00:00.000Z" },
      ],
      [
        HEAD,
        {
          tree: "e".repeat(40),
          message: "hns checkpoint head",
          committedAt: "2026-11-18T01:00:00.000Z",
        },
      ],
    ]),
    trees: new Map([
      [
        HEAD + ":",
        [
          { path: "README.md", mode: "100644", object: BLOB, size: 4 },
          { path: "src", mode: "40000", object: TREE, size: 0 },
          { path: "link", mode: "120000", object: "f".repeat(40), size: 9 },
        ],
      ],
      [HEAD + ":src", [{ path: "app.ts", mode: "100755", object: "1".repeat(40), size: 12 }]],
    ]),
    files: new Map([
      [HEAD + ":README.md", { object: BLOB, bytes: new TextEncoder().encode("hns\n") }],
      [
        HEAD + ":src/app.ts",
        { object: "1".repeat(40), bytes: new TextEncoder().encode("const a = 1;\n") },
      ],
    ]),
    calls: [],
    failures: new Map(),
  };
  return repo;
}

/** The source over the fake namespace. */
const sourceOf = (repo: FakeRepository): ReviewSource =>
  new ArtifactsReviewSource(bindingOf(repo), REPO);

/** A value one of the three reads answers; the failure probe ignores which. */
type ReviewRead = ReviewCommit | readonly ReviewTreeEntry[] | ReviewFile;

/** Read the failure a source refused with, or undefined when it answered. */
const failureOf = async (read: () => Promise<ReviewRead>): Promise<string | undefined> => {
  try {
    await read();
    return undefined;
  } catch (error) {
    return error instanceof ReviewSourceError ? error.code : "not-a-review-failure";
  }
};

// Catches: a source that reads a ref, or answers a commit it was not asked for, so the review
// would show bytes the Change does not name.
test("C3: a commit is read by its id, and the answer is the commit asked for", async () => {
  const repo = repository();
  const read = await sourceOf(repo).log(HEAD);
  expect(read).toStrictEqual<ReviewCommit>({
    commit: HEAD,
    tree: "e".repeat(40),
    message: "hns checkpoint head",
    committedAt: isoTimestamp("2026-11-18T01:00:00.000Z"),
  });
  expect(repo.calls).toStrictEqual(["get " + REPO, "log " + HEAD]);
  expect(await failureOf(() => sourceOf(repo).log("refs/hns/run/run-1"))).toBe("invalid_request");
  expect(await failureOf(() => sourceOf(repo).log("0".repeat(40)))).toBe("not_found");
});

// Catches: a tree read that follows a symlink or walks recursively, so a reviewer sees different
// bytes than the tree names.
test("C3: one directory is read at a time, with the modes the contract names", async () => {
  const repo = repository();
  const read = sourceOf(repo);
  expect(await read.readTree(HEAD, "")).toStrictEqual<readonly ReviewTreeEntry[]>([
    { path: "README.md", kind: "blob", mode: "100644", object: BLOB, size: 4 },
    { path: "src", kind: "tree", mode: "40000", object: TREE, size: 0 },
    { path: "link", kind: "blob", mode: "120000", object: "f".repeat(40), size: 9 },
  ]);
  expect((await read.readTree(HEAD, "src")).map((entry) => entry.mode)).toStrictEqual(["100755"]);
  expect(await failureOf(() => read.readTree(HEAD, "missing"))).toBe("not_found");
});

// Catches: a file read by path alone, so two commits with the same path would answer one's bytes
// for the other, and a file read that returns text rather than bytes.
test("C3: a file is read as bytes from the commit asked for", async () => {
  const repo = repository();
  const read = sourceOf(repo);
  const file: ReviewFile = await read.readFile(HEAD, "src/app.ts");
  expect(new TextDecoder().decode(file.bytes)).toBe("const a = 1;\n");
  expect(file.contentType).toBe("text/plain");
  expectTypeOf(file).toEqualTypeOf<ReviewFile>();
  expect(repo.calls).toContain("readFile " + HEAD + ":src/app.ts");
  // The base commit does not hold that file: the same path in the other commit is not an answer.
  expect(await failureOf(() => read.readFile(BASE, "src/app.ts"))).toBe("not_found");
  expect(await failureOf(() => read.readFile(HEAD, ""))).toBe("invalid_request");
});

// Catches: a path that leaves the tree being read as one inside it, so a source could answer with
// another project's bytes.
test("C3: a path that leaves the tree is refused, with no binding call", async () => {
  const repo = repository();
  const read = sourceOf(repo);
  repo.calls.length = 0;
  for (const path of ["../a.txt", "/etc/passwd", "src/../../a.txt", "./a.txt", "a//b"]) {
    expect(await failureOf(() => read.readFile(HEAD, path)), path).toBe("invalid_request");
    expect(await failureOf(() => read.readTree(HEAD, path)), path).toBe("invalid_request");
  }
  expect(repo.calls).toStrictEqual([]);
});

// Catches: a binding failure reported as "nothing there", which a review would show as an empty
// commit rather than as a read that could not be made.
test("C3: each binding failure is one closed review failure", async () => {
  const cases: readonly (readonly [string, string])[] = [
    ["NOT_FOUND", "not_found"],
    ["UPSTREAM_UNAVAILABLE", "unavailable"],
    ["INTERNAL_ERROR", "unavailable"],
    ["REMOTE_AUTH_REQUIRED", "unauthorized"],
    ["SOMETHING_NEW", "unavailable"],
  ];
  for (const [code, expected] of cases) {
    const repo = repository();
    repo.failures.set("log", artifactError(code));
    expect(await failureOf(() => sourceOf(repo).log(HEAD)), code).toBe(expected);
  }
  // A namespace with no repository of that name is not_found: a workspace that never pushed.
  const empty = new ArtifactsReviewSource({ get: () => Promise.resolve(null) }, REPO);
  expect(await failureOf(() => empty.log(HEAD))).toBe("not_found");
});

// Catches: a binding that throws something that is not its own error being reported as a review
// failure, which turns a defect into "the commit is not there".
test("a defect is not a review failure", async () => {
  const repo = repository();
  repo.failures.set("readTree", new TypeError("the binding is wired wrong"));
  await expect(sourceOf(repo).readTree(HEAD, "")).rejects.toBeInstanceOf(TypeError);
});

// Catches: an answer the binding changed shape for being trusted, so a review reads fields that
// are not there.
test("an answer that is not the shape is unavailable, not a commit", async () => {
  const loose = {
    get: () =>
      Promise.resolve({
        log: () => Promise.resolve({ what: "not a commit" }),
        readTree: () => Promise.resolve([]),
        readFile: () => Promise.resolve({ path: "a.txt", object: BLOB, bytes: "text" }),
      }),
  };
  const read = new ArtifactsReviewSource(loose, REPO);
  expect(await failureOf(() => read.log(HEAD))).toBe("unavailable");
  expect(await failureOf(() => read.readFile(HEAD, "a.txt"))).toBe("unavailable");
});

// Catches: a file larger than the limit answered whole, which the Worker cannot hold.
test("a file over the limit is too_large", async () => {
  const repo = repository();
  const small = new ArtifactsReviewSource(bindingOf(repo), REPO, 3);
  expect(await failureOf(() => small.readFile(HEAD, "README.md"))).toBe("too_large");
  const read = sourceOf(repo);
  expect(new TextDecoder().decode((await read.readFile(HEAD, "README.md")).bytes)).toBe("hns\n");
});
