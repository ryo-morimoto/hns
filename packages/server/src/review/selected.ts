import { CheckpointRecordSchema } from "@hns/core";
import type {
  CheckpointRecord,
  ReviewFailure,
  ReviewMirrorFallback,
  ReviewMirrorSide,
  ReviewReadSource,
} from "@hns/core";
import * as v from "valibot";
import { artifactsRepoName } from "../artifacts/repos.ts";
import type { DurableObjectStub, WorkerEnv } from "../edge/env.ts";
import type { ReviewDiff } from "./service.ts";
import { reviewDiff } from "./service.ts";
import { ArtifactsReviewSource } from "./artifacts.ts";
import type { ArtifactsReviewBinding } from "./artifacts.ts";
import { R2ReviewSource } from "./r2.ts";
import type { ReviewSource } from "./source.ts";
/**
 * Which store a Change's diff is read from, and why (0248).
 *
 * @remarks
 * **The server decides the source; the screen only shows it.** A Change's commits are in the
 * workspace's Artifacts repository when the mirror pushed them (D106) and in the R2 checkpoint
 * packs whether or not it did. This module tries them in that order (Artifacts, then R2, then the
 * machine) and the answer names both the store that produced the diff and, for every commit that
 * Artifacts did not hold, the mirror state that explains why. Nothing here switches sources
 * silently: a diff read from R2 for a mirrored commit also says the Artifacts read failed, so a
 * screen can tell "read from the mirror" from "read despite the mirror".
 *
 * No source is replaced by another here: `R2ReviewSource` (0247) and `ArtifactsReviewSource` are
 * both real, both read by commit id, and neither one is a stand-in. The machine is the third
 * place a checkpoint's bytes may come from, and it is **not read yet**: the Worker has no route
 * that reads a commit from a machine (the granted path is the follow-up), so a selection that
 * settles on `machine` answers `unavailable` with a message that says so. That is the honest
 * answer, and not an R2 read of a commit R2 does not hold.
 */

/** What the selector needs from the environment and the workspace. */
export interface ReviewSelectionDeps {
  /** The checkpoint store (R2), or undefined when the deployment has no `OBJECTS` binding. */
  readonly objects: WorkerEnv["OBJECTS"];
  /** The Artifacts namespace, or undefined when the deployment has no mirror. */
  readonly artifacts: ArtifactsReviewBinding | undefined;
  /** The workspace whose mirror repository is read; undefined when the Change names none. */
  readonly workspaceId: string | undefined;
  /** The Workspace object, asked for each commit's recorded checkpoint; undefined when unbound. */
  readonly workspace: DurableObjectStub | undefined;
  /** The request's correlation id, for the log lines. */
  readonly requestId: string;
}

/**
 * What a review's diff read answered: the diff and where it was read from.
 *
 * @remarks
 * `source` is the store that produced the whole diff (both sides are read by one source, so a
 * diff is never half of one store). `mirror` lists only the commits that Artifacts did **not**
 * hold: empty means both sides came from the mirror, which is the answer that needs no
 * explaining. `fallback` is the sentence a screen shows when the list is not empty, so the same
 * words reach every client instead of each one composing its own.
 */
export interface SelectedReviewDiff {
  readonly diff: ReviewDiff;
  readonly source: ReviewReadSource;
  readonly mirror: readonly ReviewMirrorFallback[];
  readonly fallback: string | null;
}

/** The answer of one selected read: the diff with its source, or the failure that stopped it. */
export type SelectedReviewDiffResult =
  | { readonly ok: true; readonly value: SelectedReviewDiff }
  | { readonly ok: false; readonly failure: ReviewFailure; readonly message: string };

/** The record answer as the Workspace object sends it. */
const RecordAnswerSchema: v.GenericSchema<
  unknown,
  { readonly ok: boolean; readonly checkpoint?: CheckpointRecord | undefined }
> = v.object({
  ok: v.boolean(),
  checkpoint: v.optional(CheckpointRecordSchema),
});

/** A commit id: 40 lowercase hex characters, the only shape a Change's commits have. */
const COMMIT_ID = /^[0-9a-f]{40}$/u;

/**
 * The recorded checkpoint of one commit, through the Workspace object.
 *
 * @param workspace - The Workspace object that owns the checkpoint records.
 * @param commit - The commit id.
 * @param requestId - The request's correlation id, sent to the object.
 * @returns The record, or undefined when the object holds none for the commit.
 *
 * @remarks
 * A missing object, a `not_found`, or an unreadable answer is **undefined**, not a failure: the
 * mirror state is a fact a screen is shown, and a fact this deployment cannot read must not fail
 * a diff that R2 or Artifacts can still answer. It is logged instead, so a broken record route is
 * visible without taking the review down with it.
 */
export async function checkpointRecordOf(
  workspace: DurableObjectStub | undefined,
  commit: string,
  requestId: string,
): Promise<CheckpointRecord | undefined> {
  if (workspace === undefined) return undefined;
  let response: Response;
  try {
    response = await workspace.fetch(
      new Request(
        "https://workspace.internal/rpc/checkpoint/record?commit=" + encodeURIComponent(commit),
        { method: "GET", headers: { "x-request-id": requestId } },
      ),
    );
  } catch (error) {
    console.error(
      "review: the workspace record read failed",
      requestId,
      error instanceof Error ? error.name : "unknown",
    );
    return undefined;
  }
  if (!response.ok) {
    // 404 is the ordinary "no completed checkpoint of this commit"; anything else is a fault
    // worth a line, and neither changes the diff.
    if (response.status !== 404) {
      console.error("review: the workspace record read answered", response.status, requestId);
    }
    return undefined;
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = v.safeParse(RecordAnswerSchema, body);
  return parsed.success ? parsed.output.checkpoint : undefined;
}
/** The Artifacts source for one workspace, or undefined when nothing can be mirrored or read. */
function artifactsSource(deps: ReviewSelectionDeps): ReviewSource | undefined {
  const binding = deps.artifacts;
  const workspaceId = deps.workspaceId;
  if (binding === undefined || workspaceId === undefined || workspaceId === "") return undefined;
  try {
    return new ArtifactsReviewSource(binding, artifactsRepoName(workspaceId));
  } catch (error) {
    // A workspace id that cannot name a repository is one Artifacts cannot hold: no source.
    console.error(
      "review: the workspace cannot name an Artifacts repository",
      deps.requestId,
      error instanceof Error ? error.name : "unknown",
    );
    return undefined;
  }
}

/** The first 12 characters of a commit, which is how a screen names one. */
function shortId(commit: string): string {
  return commit.slice(0, 12);
}

/** The store a fallback side was read from, in the words the sentence uses. */
function storeWords(source: ReviewReadSource): string {
  switch (source) {
    case "r2":
      return "R2 の checkpoint";
    case "artifacts":
      return "Artifacts";
    case "machine":
      return "machine";
  }
}

/**
 * The fallback sentence for one side that Artifacts did not hold (C2).
 *
 * @param fallback - The side, its mirror status, and the store that was read instead.
 * @returns One line a screen shows.
 *
 * @remarks
 * The wording is the answer to C2: "the mirror was skipped / failed, so the checkpoint store was
 * read" is said out loud, with the commit named short and the failure named when there is one.
 * A status is never flattened into "unavailable": the mirror's own vocabulary is what explains the
 * fallback, and the typed list beside the sentence carries the same values.
 */
export function fallbackLine(fallback: ReviewMirrorFallback): string {
  const where = storeWords(fallback.source);
  const side = fallback.side === "base" ? "base" : "head";
  const commit = shortId(fallback.commit);
  switch (fallback.status) {
    case "skipped":
      return (
        side +
        " " +
        commit +
        " は Artifacts の上限を超えてミラーを skip したため、" +
        where +
        " を読みました。"
      );
    case "failed":
      return (
        side +
        " " +
        commit +
        " は Artifacts へのミラーが失敗したため（" +
        (fallback.failure === undefined ? "理由不明" : fallback.failure) +
        "）、" +
        where +
        " を読みました。"
      );
    case "pending":
      return (
        side +
        " " +
        commit +
        " は Artifacts へのミラーがまだ完了していないため、" +
        where +
        " を読みました。"
      );
    case "mirrored":
      return (
        side +
        " " +
        commit +
        " は Artifacts にあると記録されているが、読み出せなかったため、" +
        where +
        " を読みました。"
      );
  }
}

/** The sentence for a whole set of fallbacks; null when there are none. */
function fallbackSentence(fallbacks: readonly ReviewMirrorFallback[]): string | null {
  if (fallbacks.length === 0) return null;
  return fallbacks.map(fallbackLine).join(" ");
}
/** One side of a Change: the commit id and whether Artifacts answered for it. */
interface SideRead {
  readonly side: ReviewMirrorSide;
  readonly commit: string;
  readonly fromArtifacts: boolean;
}

/**
 * The mirror states of a Change's commits, as the Artifacts read found them.
 *
 * @param sides - Each commit and whether Artifacts answered for it.
 * @param records - The recorded checkpoint of each commit (undefined when none could be read).
 * @param source - The store that was read instead.
 * @returns One fallback per side Artifacts did not hold.
 *
 * @remarks
 * A commit with **no recorded checkpoint** did not come from Artifacts: nothing was recorded for
 * it, so the mirror cannot hold it, and `pending` is the honest word for a checkpoint that has
 * not landed. A record says why in the mirror's own vocabulary. A commit whose record says
 * `mirrored` but which Artifacts did not answer is a mismatch between the record and the store,
 * and it is reported as such rather than hidden.
 */
function fallbacksFor(
  sides: readonly SideRead[],
  records: ReadonlyMap<string, CheckpointRecord | undefined>,
  source: ReviewReadSource,
): readonly ReviewMirrorFallback[] {
  const fallbacks: ReviewMirrorFallback[] = [];
  for (const side of sides) {
    if (side.fromArtifacts) continue;
    const record = records.get(side.commit);
    if (record === undefined) {
      fallbacks.push({ side: side.side, commit: side.commit, status: "pending", source });
      continue;
    }
    const failure = record.mirror.status === "failed" ? record.mirror.failure : undefined;
    fallbacks.push(
      failure === undefined
        ? { side: side.side, commit: side.commit, status: record.mirror.status, source }
        : { side: side.side, commit: side.commit, status: "failed", failure, source },
    );
  }
  return fallbacks;
}

/**
 * Read a Change's diff from the first source that can read both commits.
 *
 * @param deps - The bindings, the workspace, and the request id.
 * @param base - The base commit id.
 * @param head - The head commit id.
 * @returns The diff with the store it came from, or the last source's failure.
 *
 * @remarks
 * The order is the design's (0248): **Artifacts, then R2, then machine**. A source that answers
 * `not_found` or `unavailable` did not read the pair, so the next one is tried; a source that
 * answers with a diff is the answer, and no later source is consulted. The failures of the
 * sources that were passed over are logged (codes, never a message), because "why was this read
 * from R2?" is otherwise invisible.
 *
 * **The machine is not read.** No Worker route reads a commit from a machine yet (the granted
 * path is the follow-up), so when Artifacts and R2 both fail the answer is `unavailable` with a
 * sentence that names the machine as the source that is not available yet: never an empty diff,
 * and never a silent switch to a store that did read something else.
 */
export async function selectedReviewDiff(
  deps: ReviewSelectionDeps,
  base: string,
  head: string,
): Promise<SelectedReviewDiffResult> {
  if (!COMMIT_ID.test(base) || !COMMIT_ID.test(head)) {
    return {
      ok: false,
      failure: "invalid_request",
      message: "A review is read between two commit ids.",
    };
  }
  const sides: readonly { readonly side: ReviewMirrorSide; readonly commit: string }[] = [
    { side: "base", commit: base },
    { side: "head", commit: head },
  ];

  const artifacts = artifactsSource(deps);
  if (artifacts === undefined) {
    console.error("review: no Artifacts source for this diff", deps.requestId);
  } else {
    const result = await reviewDiff(artifacts, base, head);
    if (result.ok) {
      return {
        ok: true,
        value: { diff: result.diff, source: "artifacts", mirror: [], fallback: null },
      };
    }
    console.error("review: Artifacts could not read the diff", deps.requestId, result.failure);
    if (result.failure === "invalid_request" || result.failure === "too_large") {
      // The request (or the size it would need) is the answer, not a reason to try elsewhere:
      // a commit id Artifacts refused is refused by every source.
      return { ok: false, failure: result.failure, message: result.message };
    }
  }

  const bucket = deps.objects;
  if (bucket === undefined) {
    console.error("review: no checkpoint store for this diff", deps.requestId);
    return {
      ok: false,
      failure: "unavailable",
      message:
        "The change could not be read from Artifacts, and this deployment has no checkpoint store to read it from.",
    };
  }
  const result = await reviewDiff(new R2ReviewSource(bucket), base, head);
  if (!result.ok) {
    console.error("review: R2 could not read the diff", deps.requestId, result.failure);
    return {
      ok: false,
      failure: result.failure,
      message:
        "The change could not be read from Artifacts or the checkpoint store; reading it from the machine is not available yet.",
    };
  }
  const records = new Map<string, CheckpointRecord | undefined>();
  for (const side of sides) {
    records.set(side.commit, await checkpointRecordOf(deps.workspace, side.commit, deps.requestId));
  }
  const mirror = fallbacksFor(
    sides.map((side) => ({ ...side, fromArtifacts: false })),
    records,
    "r2",
  );
  return {
    ok: true,
    value: { diff: result.diff, source: "r2", mirror, fallback: fallbackSentence(mirror) },
  };
}
