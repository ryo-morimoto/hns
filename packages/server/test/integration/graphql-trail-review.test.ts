import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import { isoTimestamp } from "@hns/core";
import type { JsonValue, ReviewCommit, ReviewFile, ReviewTreeEntry } from "@hns/core";
import { fromGlobalId, toGlobalId } from "@hns/core/graphql";
import type { Store } from "@hns/store";
import { createD1Harness, type D1Harness } from "../../../store/test/integration/harness.ts";
import { createGraphQLFace, type GraphQLFaceDependencies } from "../../src/graphql/handler.ts";
import { policyFaceOver } from "../../src/graphql/policy/face.ts";
import { reviewDiff } from "../../src/review/service.ts";
import { FakeReviewSource } from "../../src/review/source.ts";
import { envWith } from "../support/edge.ts";

/**
 * The review face (0232) over the production parts (C1–C4).
 *
 * @remarks
 * The real face (`createGraphQLFace`) over a **real D1** with migration 0010, the real store
 * repository, the real diff engine (`reviewDiff`, 0009 / 0011), the real `core` rules, and the
 * documents the web app ships (the compiled `TrailDetailQuery` and its fragments). Only two things
 * are not production: the commits (a `FakeReviewSource`, because a checkpoint pack needs R2 and a
 * machine), and the file a hunk write lands in (a temporary directory, because the review face's
 * production write has no writable workspace — see 0232's Result).
 *
 * **C1** is read through `TrailChange.diff` in the web document's own selection: file, hunk, line.
 * **C2** is approve → new head → the gate and the decision list agree the approval no longer holds,
 * and a second approve names the new head. **C3** is a high finding blocking the gate line, then a
 * dismissed one no longer blocking. **C4** is a revise whose findings reach the next Run's input,
 * as `decideTrail` answers it and as the server hands it to a conversation.
 */

/** The operation text of one compiled document, which is what the browser sends. */
function textOf(operation: { readonly params: { readonly text?: string | null } }): string {
  const text = operation.params.text;
  if (text === null || text === undefined) throw new Error("the operation has no text");
  return text;
}

const BASE = "1".repeat(40);
const NEXT_HEAD = "3".repeat(40);
const HUMAN = "owner";

/** The commits the review reads: a base, the head a change was made against, and a new head. */
const HEAD = "2".repeat(40);

const commit = (id: string): ReviewCommit => ({
  commit: id,
  tree: id.slice(0, 40),
  message: "checkpoint " + id.slice(0, 7),
  committedAt: isoTimestamp("2026-11-18T00:00:00.000Z"),
});

const blob = (path: string, object: string, size: number): ReviewTreeEntry => ({
  path,
  kind: "blob",
  mode: "100644",
  object,
  size,
});

const file = (path: string, object: string, text: string): ReviewFile => ({
  path,
  object,
  contentType: "text/plain",
  bytes: new TextEncoder().encode(text),
});

/**
 * A source with a base and one head: `src/app.ts` gains a line and `README.md` is unchanged.
 *
 * @remarks
 * The base side of `src/app.ts` is one line and the head is three, so the diff has a hunk with a
 * deleted line, an added line, and the context between them — the three line kinds C1 names.
 */
function sourceOf(): FakeReviewSource {
  const trees = new Map<string, readonly ReviewTreeEntry[]>([
    [BASE + ":", [blob("README.md", "readme", 2), blob("src/app.ts", "app-base", 6)]],
    [HEAD + ":", [blob("README.md", "readme", 2), blob("src/app.ts", "app-head", 18)]],
  ]);
  const files = new Map<string, ReviewFile>([
    [BASE + ":README.md", file("README.md", "readme", "hns\n")],
    [HEAD + ":README.md", file("README.md", "readme", "hns\n")],
    [BASE + ":src/app.ts", file("src/app.ts", "app-base", "const a = 1;\n")],
    [
      HEAD + ":src/app.ts",
      file("src/app.ts", "app-head", "const a = 1;\nconst b = 2;\nconst c = 3;\n"),
    ],
  ]);
  return new FakeReviewSource(
    new Map([
      [BASE, commit(BASE)],
      [HEAD, commit(HEAD)],
    ]),
    trees,
    files,
  );
}

let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

/**
 * Run one operation through the production handler.
 *
 * @param store - The store the diff and the project are read through.
 * @param query - The operation text.
 * @param variables - Its variables.
 */
async function post(
  store: Store,
  query: string,
  variables: Record<string, JsonValue>,
): Promise<JsonValue> {
  const source = sourceOf();
  const face = createGraphQLFace({
    reads: {
      project: (projectId) => store.projects.get(projectId),
      reviewDiff: async (base, head) => {
        const result = await reviewDiff(source, base, head);
        return result.ok
          ? { ok: true, diff: result.diff }
          : { ok: false, code: result.failure, message: result.message };
      },
    },
    policy: policyFaceOver(store, { bashSandbox: false }),
  } satisfies GraphQLFaceDependencies);
  const response = await face({
    request: new Request("https://hns.test/graphql", { method: "POST" }),
    env: envWith({ db: harness.db }),
    session: { subject: HUMAN, expiresAt: 0 },
    requestId: "review-face",
    signal: new AbortController().signal,
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const body: unknown = JSON.parse(text);
  if (!isRecord(body)) throw new Error("no data in " + text);
  const data = body["data"];
  if (!isRecord(data)) throw new Error("no data in " + text);
  return data;
}

/** A JSON object: the body's `data`, or one field of it. */
const JsonObjectSchema = v.record(v.string(), v.unknown());

/** A parsed JSON object (its values are parsed where they are read). */
type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Parse a JSON value as an object.
 *
 * @param value - A parsed body, or one field of it.
 * @returns The object.
 * @throws ValiError when the value is not a JSON object.
 */
/* oxlint-disable anti-slop/no-unknown-parameters --
   Every parsed body and field is `unknown` until this parse checks it; that is its purpose.
*/
function isRecord(value: unknown): value is JsonObject {
  /* oxlint-enable anti-slop/no-unknown-parameters */
  return v.safeParse(JsonObjectSchema, value).success;
}

/** One field of the answer, which the selection guarantees is an object. */
function fieldOf(data: JsonValue, name: string): { readonly [key: string]: JsonValue } {
  const body: unknown = data;
  const field = isRecord(body) ? body[name] : undefined;
  if (!isRecord(field)) throw new Error("no field " + name + " in " + JSON.stringify(data));
  return field;
}

/** The Trail the detail read answered, or a thrown message for a typed failure. */
function trailOf(data: JsonValue): { readonly [key: string]: JsonValue } {
  const trail = fieldOf(data, "trail");
  if (trail["__typename"] === "QueryFailure") throw new Error(String(trail["message"]));
  const found = trail["trail"];
  if (!isRecord(found)) throw new Error("the payload has no trail");
  return found;
}

/** A raw store id decoded from a global id the face answered. */
function rawOf(globalId: string): string {
  const decoded = fromGlobalId(globalId);
  if (!decoded.ok) throw new Error("not a global id: " + globalId);
  return decoded.value.id;
}

/**
 * Create a Trail with one Change (base..head) through the store's own repository.
 *
 * @returns The Trail's global id and raw id, the Change's global id, and the project's global id.
 */
async function trailWithChange(store: Store): Promise<{
  trailId: string;
  trailGlobal: string;
  changeGlobal: string;
  projectGlobal: string;
}> {
  const project = await store.projects.create("review-face", "projects/review-face");
  const trail = await store.trails.create({
    projectId: project.id,
    title: "The review face",
    description: "read a change",
    acceptance: "the diff is readable",
    createdBy: HUMAN,
  });
  if (trail.refused) throw new Error("the trail was refused");
  const change = await store.trails.addChange(trail.id, {
    workspaceId: "workspace-1",
    baseCommit: BASE,
    headCommit: HEAD,
  });
  if (change.refused) throw new Error("the change was refused: " + change.kind);
  return {
    trailId: trail.id,
    trailGlobal: toGlobalId("Trail", trail.id),
    changeGlobal: toGlobalId("TrailChange", change.id),
    projectGlobal: toGlobalId("Project", project.id),
  };
}

/** The decision operations, wrapped so each test sends one. */
const DECIDE = `mutation ReviewFaceDecide($input: DecideTrailInput!) {
  decideTrail(input: $input) {
    __typename
    ... on DecideTrailPayload { decision { id action headCommit actor } nextRunInput }
    ... on MutationFailure { code message }
  }
}`;

/** One finding, wrapped. */
const FINDING = `mutation ReviewFaceFinding($input: RaiseFindingInput!) {
  raiseFinding(input: $input) {
    __typename
    ... on RaiseFindingPayload { finding { id severity status summary } }
    ... on MutationFailure { code message }
  }
}`;

/** The detail read: the web document's fragment plus the pieces this suite asserts on. */
const DETAIL = `query ReviewFaceDetail($id: ID!) {
  trail(id: $id) {
    __typename
    ... on TrailPayload {
      trail {
        id
        title
        changes {
          id
          baseCommit
          headCommit
          ...ReviewFaceDiff
        }
        findings { id severity source status summary }
        decisions { id action actor headCommit }
        gates { line lines { gate status detail } }
        sessions { id conversationId }
      }
    }
    ... on QueryFailure { code message }
  }
}`;

/** The Change's diff, selected exactly as the web app's fragment selects it. */
const DIFF_FRAGMENT = `fragment ReviewFaceDiff on TrailChange {
  diff {
    __typename
    ... on ReviewDiff {
      baseCommit
      headCommit
      added
      removed
      files {
        path
        change
        added
        removed
        previewable
        hunks {
          baseStart
          headStart
          lines { kind text }
        }
      }
    }
    ... on QueryFailure { code message }
  }
}`;

/** Read the detail through the face. */
async function detailOf(store: Store, trailGlobal: string) {
  return trailOf(await post(store, DIFF_FRAGMENT + DETAIL, { id: trailGlobal }));
}

/** The gate line's status for one gate. */
function gateStatus(trail: { readonly [key: string]: JsonValue }, gate: string): string {
  const gates = trail["gates"];
  if (!isRecord(gates)) throw new Error("no gates");
  const lines = gates["lines"];
  if (!Array.isArray(lines)) throw new Error("no gate lines");
  for (const line of lines) {
    if (isRecord(line) && line["gate"] === gate) return String(line["status"]);
  }
  throw new Error("no gate " + gate);
}

/** Decide through the face, answering the payload or throwing the failure's message. */
async function decide(
  store: Store,
  input: Record<string, JsonValue>,
): Promise<{ readonly [key: string]: JsonValue }> {
  const payload = fieldOf(await post(store, DECIDE, { input }), "decideTrail");
  if (payload["__typename"] === "MutationFailure") throw new Error(String(payload["message"]));
  return payload;
}

/**
 * C1: the Change's diff reaches the screen as files, hunks, and lines.
 *
 * @remarks
 * The web app's own selection (`DIFF_FRAGMENT`) over the real face, the real diff engine, and the
 * Change row the store wrote. Catches a diff that is not served, a hunk with no line kinds, the
 * unchanged file appearing, and the pair being anything but the Change's own commits.
 */
test("C1: a Change's diff shows its file, hunk, and lines", async () => {
  await harness.withStore(async (store) => {
    const created = await trailWithChange(store);
    const detail = await detailOf(store, created.trailGlobal);
    const changes = detail["changes"];
    if (!Array.isArray(changes) || changes.length !== 1 || !isRecord(changes[0])) {
      throw new Error("expected one change");
    }
    const diff = changes[0]["diff"];
    if (!isRecord(diff) || diff["__typename"] !== "ReviewDiff") {
      throw new Error("expected a diff, got " + JSON.stringify(diff));
    }
    expect(diff["baseCommit"]).toBe(BASE);
    expect(diff["headCommit"]).toBe(HEAD);
    expect(diff["added"]).toBe(2);
    expect(diff["removed"]).toBe(0);
    const files = diff["files"];
    if (!Array.isArray(files) || files.length !== 1 || !isRecord(files[0])) {
      throw new Error("expected one file, got " + JSON.stringify(files));
    }
    const app = files[0];
    expect(app["path"]).toBe("src/app.ts");
    expect(app["change"]).toBe("MODIFIED");
    expect(app["previewable"]).toBe(true);
    const hunks = app["hunks"];
    if (!Array.isArray(hunks) || hunks.length !== 1 || !isRecord(hunks[0])) {
      throw new Error("expected one hunk");
    }
    expect(hunks[0]["baseStart"]).toBe(1);
    expect(hunks[0]["headStart"]).toBe(1);
    const lines = hunks[0]["lines"];
    if (!Array.isArray(lines)) throw new Error("expected lines");
    expect(
      lines.map((line) => (isRecord(line) ? line["kind"] + " " + line["text"] : "")),
    ).toStrictEqual(["CONTEXT const a = 1;", "ADD const b = 2;", "ADD const c = 3;"]);
  });
});

/**
 * C1: a commit with no checkpoint pack is "not readable yet", never an empty diff.
 *
 * @remarks
 * Catches a diff read that answers an empty file list for a commit it could not read (which a
 * reviewer would read as "nothing changed") and the pair being taken from the caller.
 */
test("C1: a diff the engine cannot read is a typed failure, not an empty change", async () => {
  await harness.withStore(async (store) => {
    const created = await trailWithChange(store);
    const other = await store.trails.addChange(created.trailId, {
      workspaceId: "workspace-1",
      baseCommit: BASE,
      headCommit: NEXT_HEAD,
    });
    if (other.refused) throw new Error("the change was refused");
    const detail = await detailOf(store, created.trailGlobal);
    const changes = detail["changes"];
    if (!Array.isArray(changes)) throw new Error("expected changes");
    const last = changes[changes.length - 1];
    if (!isRecord(last)) throw new Error("expected a change");
    expect(last["diff"]).toMatchObject({ __typename: "QueryFailure", code: "NOT_FOUND" });
  });
});

/**
 * C2: approve names the head, a new head invalidates it, and a second approve names the new head.
 *
 * @remarks
 * Catches an approval that does not carry its head, a gate that counts an approval of an older
 * commit, and a store that accepts an approval for a commit the Trail does not have.
 */
test("C2: an approval holds for its head only, and a new head takes the gate back", async () => {
  await harness.withStore(async (store) => {
    const created = await trailWithChange(store);
    const first = await decide(store, {
      trailId: created.trailGlobal,
      action: "APPROVE",
      headCommit: HEAD,
    });
    expect(first["decision"]).toMatchObject({ action: "APPROVE", headCommit: HEAD, actor: HUMAN });

    const approved = await detailOf(store, created.trailGlobal);
    expect(gateStatus(approved, "HUMAN_REVIEW")).toBe("PASS");
    // With the human gate passed, the line names what still stops the merge (tests is `ask`).
    const approvedGates = approved["gates"];
    if (!isRecord(approvedGates)) throw new Error("no gates");
    expect(String(approvedGates["line"])).not.toContain("human_review");

    // A new head: the approval is still recorded, and no longer holds.
    const next = await store.trails.addChange(created.trailId, {
      workspaceId: "workspace-1",
      baseCommit: HEAD,
      headCommit: NEXT_HEAD,
    });
    if (next.refused) throw new Error("the change was refused");
    const moved = await detailOf(store, created.trailGlobal);
    expect(gateStatus(moved, "HUMAN_REVIEW")).toBe("FAIL");
    const decisions = moved["decisions"];
    if (!Array.isArray(decisions)) throw new Error("expected decisions");
    // The record is append-only: the first approval is still there, naming the head it approved.
    expect(
      decisions.some((decision) => isRecord(decision) && decision["headCommit"] === HEAD),
    ).toBe(true);

    // A second approve for the new head is the one that holds now.
    await decide(store, {
      trailId: created.trailGlobal,
      action: "APPROVE",
      headCommit: NEXT_HEAD,
    });
    const reapproved = await detailOf(store, created.trailGlobal);
    expect(gateStatus(reapproved, "HUMAN_REVIEW")).toBe("PASS");
    const latest = reapproved["decisions"];
    if (!Array.isArray(latest) || !isRecord(latest[0])) throw new Error("expected decisions");
    expect(latest[0]["headCommit"]).toBe(NEXT_HEAD);
  });
});

/**
 * C2: an approval for a commit the Trail does not have is refused, and nothing is written.
 *
 * @remarks
 * Catches the store accepting a head it cannot check (an approval that could never go stale).
 */
test("C2: an approval of an unknown head is refused and records nothing", async () => {
  await harness.withStore(async (store) => {
    const created = await trailWithChange(store);
    const answer = fieldOf(
      await post(store, DECIDE, {
        input: {
          trailId: created.trailGlobal,
          action: "APPROVE",
          headCommit: "f".repeat(40),
        },
      }),
      "decideTrail",
    );
    expect(answer).toMatchObject({ __typename: "MutationFailure", code: "INVALID_REQUEST" });
    const detail = await detailOf(store, created.trailGlobal);
    expect(detail["decisions"]).toStrictEqual([]);
  });
});

/**
 * C3: a high finding that is open blocks the merge, and the line says why.
 *
 * @remarks
 * Catches a gate that does not read findings, a gate that lets a `high` finding through, and a
 * line that does not name the gate that stops the merge. The finding is raised through the face's
 * own mutation, so the vocabulary and the store row are the production ones.
 */
test("C3: an open high finding blocks the merge, and dismissing it unblocks", async () => {
  await harness.withStore(async (store) => {
    const created = await trailWithChange(store);
    const raised = fieldOf(
      await post(store, FINDING, {
        input: {
          trailId: created.trailGlobal,
          severity: "HIGH",
          source: "AGENT",
          summary: "the retry loops forever",
          file: "src/app.ts",
        },
      }),
      "raiseFinding",
    );
    if (raised["__typename"] !== "RaiseFindingPayload") {
      throw new Error("the finding was refused: " + JSON.stringify(raised));
    }
    expect(raised["finding"]).toMatchObject({ severity: "HIGH", status: "OPEN" });

    const blocked = await detailOf(store, created.trailGlobal);
    expect(gateStatus(blocked, "FINDINGS")).toBe("FAIL");
    const gates = blocked["gates"];
    if (!isRecord(gates)) throw new Error("no gates");
    expect(String(gates["line"])).toContain("findings");
    expect(String(gates["line"])).toContain("high");

    // The record is the screen's default list: the blocking finding is in it.
    const findings = blocked["findings"];
    if (!Array.isArray(findings)) throw new Error("no findings");
    expect(findings).toHaveLength(1);

    // Dismissing it is a decision a person records; the gate reads the status, so it passes.
    const finding = raised["finding"];
    if (!isRecord(finding)) throw new Error("no finding");
    const decided = await decide(store, {
      trailId: created.trailGlobal,
      action: "REQUEST_CHANGES",
      headCommit: HEAD,
      resolveFindingIds: [String(finding["id"])],
    });
    expect(decided["decision"]).toMatchObject({ action: "REQUEST_CHANGES" });
    const resolved = await detailOf(store, created.trailGlobal);
    expect(gateStatus(resolved, "FINDINGS")).toBe("PASS");
    const after = resolved["findings"];
    if (!Array.isArray(after) || !isRecord(after[0])) throw new Error("no findings");
    expect(after[0]["status"]).toBe("RESOLVED");
  });
});

/**
 * C4: a revise answers the open findings as the next Run's input.
 *
 * @remarks
 * Catches a revise that records the decision and drops the points: `decideTrail` answers
 * `nextRunInput` from `core`'s `trailReviseInput` over the findings the store holds, so the text a
 * next Run is given is the review's own words, with where each point is.
 */
test("C4: a revise carries its open findings into the next Run's input", async () => {
  await harness.withStore(async (store) => {
    const created = await trailWithChange(store);
    for (const [severity, summary] of [
      ["LOW", "rename the helper"],
      ["HIGH", "the retry loops forever"],
    ] as const) {
      const raised = fieldOf(
        await post(store, FINDING, {
          input: {
            trailId: created.trailGlobal,
            severity,
            source: "HUMAN",
            summary,
            file: "src/app.ts",
            hunk: "@@ -1,1 +1,3 @@",
          },
        }),
        "raiseFinding",
      );
      expect(raised["__typename"]).toBe("RaiseFindingPayload");
    }
    const revised = await decide(store, {
      trailId: created.trailGlobal,
      action: "REQUEST_CHANGES",
      headCommit: HEAD,
      note: "please fix the loop",
    });
    const input = String(revised["nextRunInput"]);
    expect(input).toContain("head " + HEAD);
    // The blocking point is first, and both points travel with their place.
    expect(input.indexOf("the retry loops forever")).toBeLessThan(
      input.indexOf("rename the helper"),
    );
    expect(input).toContain("src/app.ts @@ -1,1 +1,3 @@: the retry loops forever");
    expect(input).toContain("[high]");
    expect(input).toContain("[low]");

    // The revise is recorded with its head and note, beside the input it hands the next Run.
    const decisions = (await detailOf(store, created.trailGlobal))["decisions"];
    if (!Array.isArray(decisions) || !isRecord(decisions[0])) throw new Error("no decision");
    expect(decisions[0]).toMatchObject({ action: "REQUEST_CHANGES", headCommit: HEAD });
  });
});

/**
 * The detail read serves the four lists the Sidebar/face promised (0232): sessions, findings,
 * decisions, and the computed gates, for a Trail with none of them.
 *
 * @remarks
 * Catches a field added to the schema with no source, and a gate set that is empty rather than
 * `ask`/`fail` for a Trail nothing has happened to yet.
 */
test("the detail read answers every review list, empty where nothing happened", async () => {
  await harness.withStore(async (store) => {
    const created = await trailWithChange(store);
    const detail = await detailOf(store, created.trailGlobal);
    expect(detail["sessions"]).toStrictEqual([]);
    expect(detail["findings"]).toStrictEqual([]);
    expect(detail["decisions"]).toStrictEqual([]);
    expect(gateStatus(detail, "HUMAN_REVIEW")).toBe("FAIL");
    expect(gateStatus(detail, "TESTS")).toBe("ASK");
    expect(gateStatus(detail, "FRESHNESS")).toBe("PASS");
    const gates = detail["gates"];
    if (!isRecord(gates)) throw new Error("no gates");
    expect(String(gates["line"]).startsWith("merge: blocked")).toBe(true);
    // A Trail with no Change has nothing to approve: the line says so.
    expect(String(gates["line"])).toContain("human_review");
  });
});

/** The web app's compiled detail document is one the face can serve. */
test("the web app's review face document is a request the face accepts", async () => {
  const operation = await import("../../../web/src/__generated__/TrailDetailQuery.graphql.ts");
  const text = textOf(operation.default);
  expect(text).toContain("query TrailDetailQuery");
  expect(text).toContain("changes");
  expect(text).toContain("findings");
  expect(text).toContain("decisions");
  expect(text).toContain("gates");
  expect(text).toContain("sessions");
  await harness.withStore(async (store) => {
    const created = await trailWithChange(store);
    const data = await post(store, text, { id: created.trailGlobal });
    const trail = trailOf(data);
    expect(trail["title"]).toBe("The review face");
    const changes = trail["changes"];
    if (!Array.isArray(changes) || !isRecord(changes[0])) throw new Error("no change");
    expect(changes[0]["diff"]).toMatchObject({ __typename: "ReviewDiff" });
  });
});

/** The raw id of the Change the detail answered, for the hunk writes below. */
async function changeOf(
  store: Store,
  trailGlobal: string,
): Promise<{ readonly id: string; readonly head: string }> {
  const detail = await detailOf(store, trailGlobal);
  const changes = detail["changes"];
  if (!Array.isArray(changes) || !isRecord(changes[0])) throw new Error("no change");
  return { id: rawOf(String(changes[0]["id"])), head: String(changes[0]["headCommit"]) };
}

/**
 * The hunk mutations reach the review port with the Change's own pair and the caller's version.
 *
 * @remarks
 * The Worker cannot write a file (its port is `unavailable`), so this suite asserts what it *can*
 * assert on this path: the mutation decodes the ids, looks the pair up in the store, and hands the
 * port exactly that. The rules behind the port — keep / undo / apply through the real versioned
 * write and a conflict when the file moved — are proven in `review/write.test.ts`.
 */
test("a hunk action hands the review port the Change's pair and the caller's version", async () => {
  await harness.withStore(async (store) => {
    const created = await trailWithChange(store);
    const change = await changeOf(store, created.trailGlobal);
    const seen: string[] = [];
    const face = createGraphQLFace({
      reads: {
        project: (projectId) => store.projects.get(projectId),
      },
      review: {
        hunk: async (action, input) => {
          seen.push(action + " " + input.base + " " + input.head + " " + input.path);
          return {
            ok: false,
            code: "unavailable",
            message: "This deployment cannot write a file from a review.",
          };
        },
      },
      policy: policyFaceOver(store, { bashSandbox: false }),
    } satisfies GraphQLFaceDependencies);
    const answer = async (field: string): Promise<JsonValue> => {
      const response = await face({
        request: new Request("https://hns.test/graphql", { method: "POST" }),
        env: envWith({ db: harness.db }),
        session: { subject: HUMAN, expiresAt: 0 },
        requestId: "review-hunk",
        signal: new AbortController().signal,
        body: JSON.stringify({
          query:
            "mutation Hunk($input: ReviewHunkInput!) { " +
            field +
            "(input: $input) { __typename ... on MutationFailure { code message } } }",
          variables: {
            input: {
              changeId: toGlobalId("TrailChange", change.id),
              path: "src/app.ts",
              headStart: 1,
              expectedVersion: "absent",
            },
          },
        }),
      });
      const body: unknown = JSON.parse(await response.text());
      if (!isRecord(body)) throw new Error("no data");
      const data = body["data"];
      if (!isRecord(data)) throw new Error("no data");
      return data[field] ?? null;
    };
    expect(await answer("keepHunk")).toMatchObject({
      __typename: "MutationFailure",
      code: "UNAVAILABLE",
    });
    expect(seen).toStrictEqual(["keep " + BASE + " " + HEAD + " src/app.ts"]);
  });
});
