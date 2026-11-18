import { useState, type ReactElement } from "react";
import { useMutation, useRelayEnvironment } from "react-relay";
import { commitLocalUpdate } from "relay-runtime";
import type { TrailDetailChangeDiff$key } from "../../__generated__/TrailDetailChangeDiff.graphql";
import type { TrailDetailReview$key } from "../../__generated__/TrailDetailReview.graphql";
import type { TrailDetailDecideMutation } from "../../__generated__/TrailDetailDecideMutation.graphql";
import type { TrailDetailKeepHunkMutation } from "../../__generated__/TrailDetailKeepHunkMutation.graphql";
import type { TrailDetailUndoHunkMutation } from "../../__generated__/TrailDetailUndoHunkMutation.graphql";
import type { TrailDetailApplyHunkMutation } from "../../__generated__/TrailDetailApplyHunkMutation.graphql";
import { useFragment } from "react-relay";
import { Badge } from "../../components/Badge.tsx";
import { Button } from "../../components/Button.tsx";
import { formatRelative } from "../../app/relativeTime.ts";
import {
  DecideTrailMutation,
  TrailDetailChangeDiffFragment,
  TrailDetailReviewFragment,
} from "./TrailDetail.ts";
import { KeepHunkMutation, UndoHunkMutation, ApplyHunkMutation } from "./TrailDetail.ts";
import {
  GATE_LABELS,
  SEVERITY_LABELS,
  currentApproval,
  visibleFindings,
  type ReviewDecision,
  type ReviewFinding,
} from "./review.ts";
import "./trail.css";

/** The line kinds the diff engine emits, as the CSS class each line takes. */
const LINE_CLASS = {
  CONTEXT: "hns-diff__line--context",
  ADD: "hns-diff__line--add",
  DEL: "hns-diff__line--del",
} as const;

/** What the hunk buttons ask the server for; the port is `context.review.hunk` (see 0232's report). */
type HunkAction = "keep" | "undo" | "apply";

/**
 * The review face (0232): one Trail, read in the order a person decides in.
 *
 * @remarks
 * **The diff and the unresolved points come first** (the issue's Notes; §4.4's sheet): the intent,
 * the change, the finding that blocks, the gate line, then the diff, and only then the record of
 * decisions and sessions. The process is not the main character.
 *
 * **The screen writes nothing it keeps.** Approve / revise are mutations; the answer is the
 * server's, and the screen re-reads the Trail record so the gate line and the findings move with
 * it (D077). The hunk buttons go through the server's versioned write (`keepHunk` / `undoHunk` /
 * `applyHunk`), with the file version the diff was read at — the UI is not the authority (D104).
 *
 * **Three pieces of state, all local:** whether the reader wants every finding (default: blocking
 * only), the last decision's answer (its `nextRunInput`, which is what a revise hands the next
 * Run), and any write's failure. None of them is derived from the store.
 */
export function TrailDetail({
  trailRef,
}: {
  readonly trailRef: TrailDetailReview$key;
}): ReactElement {
  const trail = useFragment(TrailDetailReviewFragment, trailRef);
  const environment = useRelayEnvironment();
  const [commitDecide] = useMutation<TrailDetailDecideMutation>(DecideTrailMutation);
  const [showAllFindings, setShowAllFindings] = useState(false);
  const [nextRunInput, setNextRunInput] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const head = trail.changes[trail.changes.length - 1]?.headCommit;
  const approval = currentApproval(decisionsOf(trail.decisions), head);
  const findings = trail.findings.map(findingOf);
  const blocking = visibleFindings(findings, false);
  const blockingOpen = blocking.length;

  const reread = (): void => {
    commitLocalUpdate(environment, (store) => {
      store.get(trail.id)?.invalidateRecord();
    });
  };

  const decide = (action: "APPROVE" | "REQUEST_CHANGES"): void => {
    setPending(true);
    setFailure(null);
    // The head on screen is the one the decision names. With no Change there is nothing to
    // approve, so the approve button is disabled; a revise still names no head.
    const input: TrailDetailDecideMutation["variables"]["input"] = {
      trailId: trail.id,
      action,
      note: "",
    };
    if (head !== undefined) input.headCommit = head;
    commitDecide({
      variables: { input },
      onCompleted: (answer) => {
        setPending(false);
        const member = answer.decideTrail;
        if (member.__typename !== "DecideTrailPayload") {
          setFailure(
            member.__typename === "MutationFailure"
              ? member.message
              : "判断を記録できませんでした。",
          );
          return;
        }
        setNextRunInput(member.nextRunInput);
        reread();
      },
      onError: (error) => {
        setPending(false);
        setFailure(error.message);
      },
    });
  };

  return (
    <article className="hns-review" aria-labelledby="review-title">
      <header className="hns-review__head">
        <h1 id="review-title">{trail.title}</h1>
        <p className="hns-review__meta">
          {trail.kind} · {trail.priority} · {trail.state} · updated{" "}
          {formatRelative(trail.updatedAt)}
        </p>
        {trail.description === "" ? null : (
          <p className="hns-review__intent">{trail.description}</p>
        )}
        {trail.acceptance === "" ? null : (
          <p className="hns-review__acceptance">Done when: {trail.acceptance}</p>
        )}
      </header>

      {/*
        C3: the one line a person reads before deciding. It is the server's sentence
        (`Trail.gates.line`); the gate list below is its detail.
      */}
      <p className="hns-review__gate-line" data-gate-line={trail.gates.line}>
        {trail.gates.line}
      </p>

      <section className="hns-review__unresolved" aria-labelledby="unresolved-title">
        <h2 id="unresolved-title">未解決 {blockingOpen}</h2>
        {findings.length === 0 ? (
          <p className="hns-review__empty">指摘はありません。</p>
        ) : blockingOpen === 0 && !showAllFindings ? (
          <p className="hns-review__empty">止まっている指摘はありません。</p>
        ) : (
          <ul className="hns-review__findings">
            {visibleFindings(findings, showAllFindings).map((finding) => (
              <li key={finding.id} className="hns-review__finding" data-severity={finding.severity}>
                <Badge tone={finding.severity === "HIGH" ? "danger" : "neutral"}>
                  {SEVERITY_LABELS[finding.severity]}
                </Badge>
                <span className="hns-review__finding-summary">{finding.summary}</span>
                <span className="hns-review__finding-where">
                  {finding.file === null ? finding.source : finding.file}
                </span>
                <span className="hns-review__finding-status">{finding.status.toLowerCase()}</span>
              </li>
            ))}
          </ul>
        )}
        {findings.length > blocking.length ? (
          <Button variant="ghost" onClick={() => setShowAllFindings((value) => !value)}>
            {showAllFindings ? "blocking のみ" : "すべての指摘 (" + String(findings.length) + ")"}
          </Button>
        ) : null}
      </section>

      <section className="hns-review__gates" aria-labelledby="gates-title">
        <h2 id="gates-title">ゲート</h2>
        <ul className="hns-review__gate-list">
          {trail.gates.lines.map((line) => (
            <li
              key={line.gate}
              className="hns-review__gate"
              data-status={line.status}
              aria-label={
                GATE_LABELS[line.gate] + ": " + line.status.toLowerCase() + " — " + line.detail
              }
            >
              <span className="hns-review__gate-name">{GATE_LABELS[line.gate]}</span>
              <Badge tone={toneOf(line.status)}>{line.status.toLowerCase()}</Badge>
              <span className="hns-review__gate-detail">{line.detail}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="hns-review__changes" aria-labelledby="changes-title">
        <h2 id="changes-title">変更</h2>
        {trail.changes.length === 0 ? (
          <p className="hns-review__empty">変更はまだありません。</p>
        ) : (
          trail.changes.map((change) => <ChangeDiff key={change.id} changeRef={change} />)
        )}
      </section>

      {/*
        The buttons: the head they approve is the head on screen, so a stale read cannot be
        approved. `nextRunInput` is the server's answer to a revise (C4): what the next Run gets.
      */}
      <section className="hns-review__actions" aria-label="判断">
        <p className="hns-review__approval">
          {approval === undefined
            ? head === undefined
              ? "承認する変更がありません。"
              : "この head への承認はありません。"
            : "承認済み: " + (approval.headCommit ?? "") + " (" + approval.actor + ")"}
        </p>
        <div className="hns-review__buttons">
          <Button
            variant="primary"
            disabled={pending || head === undefined}
            onClick={() => decide("APPROVE")}
          >
            承認
          </Button>
          <Button variant="ghost" disabled={pending} onClick={() => decide("REQUEST_CHANGES")}>
            修正を依頼
          </Button>
        </div>
        {nextRunInput === null || nextRunInput === "" ? null : (
          <div className="hns-review__next-run">
            <h3>次の Run への入力</h3>
            <pre className="hns-review__next-run-text">{nextRunInput}</pre>
          </div>
        )}
        {failure === null ? null : (
          <p className="hns-review__failure" role="alert">
            {failure}
          </p>
        )}
      </section>

      <section className="hns-review__record" aria-labelledby="record-title">
        <h2 id="record-title">判断の記録</h2>
        {trail.decisions.length === 0 ? (
          <p className="hns-review__empty">まだありません。</p>
        ) : (
          <ul className="hns-review__decisions">
            {trail.decisions.map((decision) => (
              <li key={decision.id}>
                <span className="hns-review__decision-action">{decision.action.toLowerCase()}</span>{" "}
                <span className="hns-review__decision-actor">{decision.actor}</span>{" "}
                <span className="hns-review__decision-head">{decision.headCommit ?? ""}</span>{" "}
                <span className="hns-review__decision-at">{formatRelative(decision.at)}</span>
              </li>
            ))}
          </ul>
        )}
        {trail.sessions.length === 0 ? null : (
          <p className="hns-review__sessions">session {trail.sessions.length}</p>
        )}
      </section>
    </article>
  );
}

/**
 * The CSS class of one diff line.
 *
 * @param kind - The line's kind as the schema published it. A value this build does not know (a
 * newer server's kind) is drawn as context rather than thrown on: a line's colour is not a read.
 */
function lineClass(kind: "CONTEXT" | "ADD" | "DEL" | "%future added value"): string {
  switch (kind) {
    case "CONTEXT":
      return LINE_CLASS.CONTEXT;
    case "ADD":
      return LINE_CLASS.ADD;
    case "DEL":
      return LINE_CLASS.DEL;
    case "%future added value":
      return LINE_CLASS.CONTEXT;
  }
}

/** The badge tone a gate status takes. */
function toneOf(
  status: "PENDING" | "PASS" | "FAIL" | "ASK" | "%future added value",
): "ok" | "danger" | "warn" {
  switch (status) {
    case "PASS":
      return "ok";
    case "FAIL":
      return "danger";
    case "PENDING":
    case "ASK":
    case "%future added value":
      return "warn";
  }
}

/** A wire decision as the screen's own shape. */
function decisionsOf(
  decisions: readonly {
    readonly id: string;
    readonly action: "APPROVE" | "REQUEST_CHANGES" | "REJECT" | "%future added value";
    readonly actor: string;
    readonly headCommit: string | null | undefined;
    readonly note: string;
    readonly at: string;
  }[],
): readonly ReviewDecision[] {
  return decisions.map((decision) => ({
    id: decision.id,
    action: decision.action,
    actor: decision.actor,
    // A nullable field the server answered null is `null`; Relay's type also admits `undefined`
    // for a record it has not filled, which `?? null` makes the model's own value.
    headCommit: decision.headCommit ?? null,
    note: decision.note,
    at: decision.at,
  }));
}

/** A wire finding as the screen's own shape. */
function findingOf(finding: {
  readonly id: string;
  readonly severity: "HIGH" | "MEDIUM" | "LOW" | "NONE" | "%future added value";
  readonly source: string;
  readonly status: "OPEN" | "RESOLVED" | "DISMISSED" | "%future added value";
  readonly file: string | null | undefined;
  readonly hunk: string | null | undefined;
  readonly summary: string;
}): ReviewFinding {
  return {
    id: finding.id,
    severity: finding.severity,
    source: finding.source,
    status: finding.status,
    file: finding.file ?? null,
    hunk: finding.hunk ?? null,
    summary: finding.summary,
  };
}

/**
 * One Change: its file list, and each file's hunks and lines (C1).
 *
 * @remarks
 * **Files, then hunks, then lines** — the three layers the issue asks for. The buttons beside a
 * file are the three actions, and each is the server's versioned write with `expectedVersion`
 * `absent`: the review screen does not hold a file's version (the diff came from the commits), so
 * it says it saw nothing and the server applies only when the file is absent or already matches.
 * That is the narrowest claim a screen can make without lying about what it read.
 */
function ChangeDiff({
  changeRef,
}: {
  readonly changeRef: TrailDetailChangeDiff$key;
}): ReactElement {
  const change = useFragment(TrailDetailChangeDiffFragment, changeRef);
  const environment = useRelayEnvironment();
  const [commitKeep] = useMutation<TrailDetailKeepHunkMutation>(KeepHunkMutation);
  const [commitUndo] = useMutation<TrailDetailUndoHunkMutation>(UndoHunkMutation);
  const [commitApply] = useMutation<TrailDetailApplyHunkMutation>(ApplyHunkMutation);
  const [failure, setFailure] = useState<string | null>(null);
  const diff = change.diff;

  const write = (action: HunkAction, path: string, headStart: number): void => {
    setFailure(null);
    const variables = {
      input: {
        changeId: change.id,
        path,
        headStart,
        // The screen read the bytes from the commits, not from the file on disk: it holds no
        // version of the file. `absent` is the assertion it can make truthfully.
        expectedVersion: "absent",
      },
    };
    const onCompleted = (answer: {
      readonly keepHunk?: { readonly __typename: string; readonly message?: string | null };
      readonly undoHunk?: { readonly __typename: string; readonly message?: string | null };
      readonly applyHunk?: { readonly __typename: string; readonly message?: string | null };
    }): void => {
      const member = answer.keepHunk ?? answer.undoHunk ?? answer.applyHunk;
      if (member === undefined || member.__typename === "MutationFailure") {
        setFailure(member?.message ?? "書き込みに失敗しました。");
        return;
      }
      commitLocalUpdate(environment, (store) => {
        store.get(change.id)?.invalidateRecord();
      });
    };
    const onError = (error: Error): void => setFailure(error.message);
    if (action === "keep") commitKeep({ variables, onCompleted, onError });
    else if (action === "undo") commitUndo({ variables, onCompleted, onError });
    else commitApply({ variables, onCompleted, onError });
  };

  return (
    <div className="hns-diff" data-change={change.id}>
      <p className="hns-diff__pair">
        base {change.baseCommit.slice(0, 12)} → head {change.headCommit.slice(0, 12)}
      </p>
      {diff.__typename !== "ReviewDiff" ? (
        <p className="hns-diff__failure" role="status">
          差分を読めません:{" "}
          {diff.__typename === "QueryFailure"
            ? diff.code + " — " + diff.message
            : "この版では読めません"}
        </p>
      ) : (
        <>
          <p className="hns-diff__totals">
            {diff.files.length} files +{diff.added} -{diff.removed}
          </p>
          {diff.files.map((file) => (
            <section key={file.path} className="hns-diff__file" data-path={file.path}>
              <h3 className="hns-diff__file-head">
                <span className="hns-diff__path">{file.path}</span>
                <span className="hns-diff__kind">{file.change.toLowerCase()}</span>
                <span className="hns-diff__counts">
                  +{file.added} -{file.removed}
                </span>
                <span className="hns-diff__hunk-actions">
                  <Button
                    variant="ghost"
                    onClick={() => write("keep", file.path, file.hunks[0]?.headStart ?? 0)}
                  >
                    Keep
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => write("undo", file.path, file.hunks[0]?.headStart ?? 0)}
                  >
                    Undo
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => write("apply", file.path, file.hunks[0]?.headStart ?? 0)}
                  >
                    Apply
                  </Button>
                </span>
              </h3>
              {!file.previewable ? (
                <p className="hns-diff__binary">変更あり（プレビュー不可）</p>
              ) : (
                file.hunks.map((hunk, index) => (
                  <div
                    key={file.path + ":" + String(hunk.headStart) + ":" + String(index)}
                    className="hns-diff__hunk"
                    data-head-start={hunk.headStart}
                  >
                    <p className="hns-diff__hunk-head">
                      @@ -{hunk.baseStart} +{hunk.headStart} @@
                    </p>
                    {hunk.lines.map((line, lineIndex) => (
                      <div
                        key={lineIndex}
                        className={"hns-diff__line " + lineClass(line.kind)}
                        data-line-kind={line.kind.toLowerCase()}
                      >
                        <span className="hns-diff__sign">
                          {line.kind === "ADD" ? "+" : line.kind === "DEL" ? "-" : " "}
                        </span>
                        <span className="hns-diff__text">{line.text}</span>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </section>
          ))}
        </>
      )}
      {failure === null ? null : (
        <p className="hns-diff__failure" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}
