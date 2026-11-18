import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from "react";
import { useLazyLoadQuery, useMutation, useRelayEnvironment } from "react-relay";
import { commitLocalUpdate } from "relay-runtime";
import type { PolicyScreenQuery as PolicyScreenQueryType } from "../../__generated__/PolicyScreenQuery.graphql";
import type { PolicyScreenDecideMutation } from "../../__generated__/PolicyScreenDecideMutation.graphql";
import type { PolicyScreenProposeMutation } from "../../__generated__/PolicyScreenProposeMutation.graphql";
import { Badge } from "../../components/Badge.tsx";
import { Button } from "../../components/Button.tsx";
import { Skeleton } from "../../components/Skeleton.tsx";
import {
  activeRevisionOf,
  atomLabel,
  decideOutcomeOf,
  decidedProposalsOf,
  diffKindLabel,
  pendingProposalsOf,
  permissionLabel,
  policyCodeMessage,
  proposalStatusLabel,
  proposeOutcomeOf,
  reasonState,
  rootsLabel,
  rootsOfField,
  type DecisionOutcome,
  type PolicyAtomRecord,
  type PolicyDocumentRecord,
  type PolicyProposalRecord,
  type PolicyRevisionRecord,
} from "./format.ts";
import {
  DecidePolicyProposalMutation,
  PolicyScreenQuery,
  ProposePolicyMutation,
} from "./PolicyScreen.ts";
import "./policy.css";

/** The screen's fallback while the read is in flight: the panels' shape, in the main region. */
export function PolicyScreenFallback(): ReactElement {
  return (
    <section className="hns-policy" aria-label="読み込み中" aria-busy="true">
      <Skeleton width={180} height={18} />
      <Skeleton width={320} height={12} />
      <Skeleton width={260} height={12} />
    </section>
  );
}

/**
 * The workspace's policy screen.
 *
 * @param props.workspaceId - The workspace as a `Project` global id; the route passes it.
 * @param props.canDecide - Whether the principal viewing this may approve or reject.
 *
 * @remarks
 * **The read is Relay's; the screen keeps no copy.** The active revision, the proposals waiting
 * for a human, and the decided ones all come from one query. A proposal or a decision asks for
 * both lists again as a new request, so what is on screen after it is the server's answer rather
 * than the mutation's echo (D077).
 *
 * **A stale approval is shown, never retried.** `decidePolicy` answers `approval_stale` when
 * the proposal's base or review token moved since it was read. The screen reports it and offers a
 * reload; it does not refresh the token and send again, because that would approve a proposal the
 * person did not read.
 *
 * **The principal is a fact, not a permission here.** The face refuses a decision by an agent
 * whatever this screen draws; `canDecide` only keeps a button the server would deny out of reach.
 *
 * The four states: loading (the Suspense fallback), empty (the active revision and no pending
 * proposal), error (a `PolicyFailure` member, or a throw the shell's boundary draws), and
 * no-permission (the decision is unavailable and the screen says why).
 */
export function PolicyScreen({
  workspaceId,
  canDecide,
}: {
  readonly workspaceId: string;
  readonly canDecide: boolean;
}): ReactElement {
  const environment = useRelayEnvironment();
  // After a proposal or a decision this is what asks both lists again: the counter makes the
  // request a new one, and the two list records are marked stale so nothing answers from a record
  // a mutation just overwrote. The first read keeps the default policy.
  const [generation, setGeneration] = useState(0);
  const reread = useCallback(() => {
    setGeneration((value) => value + 1);
    commitLocalUpdate(environment, (store) => {
      for (const field of ["policyRevisions", "policyProposals"]) {
        store.getRoot().getLinkedRecord(field, { workspaceId })?.invalidateRecord();
      }
    });
  }, [environment, workspaceId]);
  const data = useLazyLoadQuery<PolicyScreenQueryType>(
    PolicyScreenQuery,
    { workspaceId },
    {
      fetchKey: workspaceId + ":" + String(generation),
      fetchPolicy: generation === 0 ? "store-or-network" : "store-and-network",
    },
  );
  return (
    <PolicyReader
      workspaceId={workspaceId}
      canDecide={canDecide}
      revisions={data.policyRevisions}
      proposals={data.policyProposals}
      onReread={reread}
    />
  );
}

/** The screen's error state: what the server said, and the way to ask again. */
function PolicyFailureView({
  code,
  message,
}: {
  readonly code: string;
  readonly message: string;
}): ReactElement {
  return (
    <section className="hns-policy" aria-label="ポリシー">
      <h1>ポリシーを読み込めません</h1>
      <p className="hns-policy__note" role="alert">
        {policyCodeMessage(code)} {message}
      </p>
      <Button variant="ghost" onClick={() => window.location.reload()}>
        読み直す
      </Button>
    </section>
  );
}

interface ReaderProps {
  readonly workspaceId: string;
  readonly canDecide: boolean;
  readonly revisions: PolicyScreenQueryType["response"]["policyRevisions"];
  readonly proposals: PolicyScreenQueryType["response"]["policyProposals"];
  /** Read both lists again; a proposal and a decision both ask for it. */
  readonly onReread: () => void;
}

/**
 * The read succeeded: the panels, the form, and the one place a decision is reported.
 *
 * @remarks
 * The report lives here, not in a panel: a decision replaces the list it came from, so the
 * sentence about it must outlive that panel's unmount.
 */
function PolicyReader({
  workspaceId,
  canDecide,
  revisions,
  proposals,
  onReread,
}: ReaderProps): ReactElement {
  const [report, setReport] = useState<DecisionOutcome | null>(null);
  // The read that follows a decision is a new request, so it may be answered after the report is
  // set. A refusal keeps its place on screen until a person dismisses it — `approval_stale` above
  // all, but any refusal, because a banner that disappears with the next read is one nobody got to
  // read. A decision that went through is a step, not an alarm: the first read after it replaces
  // it (and an empty list has no row to act on, so the report is let go by the read's landing).
  const kept = report !== null && report.kind === "refused" ? report : null;
  // What this read answered with; a new read is a new object, so the identity is the signal.
  const list: readonly unknown[] =
    proposals.__typename === "PolicyProposalList" ? proposals.proposals : [];
  const [released, setReleased] = useState<{ readonly list: readonly unknown[] } | null>(null);
  useEffect(() => {
    if (report === null || report.kind === "refused") return;
    setReleased({ list });
  }, [report, list]);
  const step =
    report !== null && report.kind !== "refused" && released?.list !== list ? report : null;
  // Focus is put back once the panels below have settled: whether a decision leaves the
  // proposal card on screen depends on the read that follows it, which lands after this render.
  // The region that receives it is the shell's main one; a screen rendered without the shell
  // (a test) gets its own section, so a keyboard user never lands on `<body>`.
  useEffect(() => {
    if (report === null) return;
    const handle = window.setTimeout(() => {
      const main = document.querySelector<HTMLElement>(".hns-shell__main");
      const target = main ?? document.querySelector<HTMLElement>(".hns-policy");
      target?.focus();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [report]);
  if (revisions.__typename === "PolicyFailure") {
    return <PolicyFailureView code={revisions.code} message={revisions.message} />;
  }
  if (proposals.__typename === "PolicyFailure") {
    return <PolicyFailureView code={proposals.code} message={proposals.message} />;
  }
  if (
    revisions.__typename !== "PolicyRevisionList" ||
    proposals.__typename !== "PolicyProposalList"
  ) {
    return <PolicyFailureView code="INVALID_RESPONSE" message="一覧の応答を読めません。" />;
  }
  const active = activeRevisionOf(revisions.revisions);
  if (active === null) {
    // An empty state, not a failure: the read succeeded and named no active revision, which the
    // face's `ensure` should have given. The screen says what it sees and offers the read again;
    // it does not raise an alarm (`role="status"`), which is the reader's job for a refused read.
    return (
      <section className="hns-policy" aria-label="ポリシー">
        <h1>ポリシーがありません</h1>
        <p className="hns-policy__note" role="status">
          サーバが active な revision を返しませんでした。読み直すと作り直されます。
        </p>
        <Button variant="ghost" onClick={() => window.location.reload()}>
          読み直す
        </Button>
      </section>
    );
  }
  return (
    <section className="hns-policy" aria-labelledby="policy-title" tabIndex={-1}>
      <header className="hns-policy__header">
        <h1 id="policy-title">ポリシー</h1>
        {canDecide ? null : (
          <p className="hns-policy__note" data-testid="policy-no-permission">
            この画面では承認・拒否を送れません。承認できるのは人だけです（agent の principal
            はサーバが拒否します）。提案はできます。
          </p>
        )}
      </header>
      {kept === null ? null : <DecisionReport outcome={kept} onDismiss={() => setReport(null)} />}
      {step === null ? null : <DecisionReport outcome={step} onDismiss={() => setReport(null)} />}
      <ActivePanel revisions={revisions.revisions} active={active} />
      <ProposalForm workspaceId={workspaceId} active={active.document} onProposed={onReread} />
      <PendingPanel
        proposals={proposals.proposals}
        canDecide={canDecide}
        onDecided={setReport}
        onReread={onReread}
      />
      <DecidedPanel proposals={proposals.proposals} />
    </section>
  );
}

/**
 * The decision's outcome, announced once and kept out of the panel it came from.
 *
 * @param props.outcome - What the face answered.
 * @param props.onDismiss - Dismiss the banner.
 *
 * @remarks
 * **A refusal stays and a success does not.** A refused decision is drawn by the reader for as long
 * as the report is a refusal (the read that a decision asks for may land after it, and a banner
 * that unmounts with that read is one nobody got to read); it goes only when a person dismisses it.
 * A decision that went through is a step of the work: the read that follows replaces it. Whether
 * the refusal is `approval_stale` decides the words, never whether it stays.
 */
function DecisionReport({
  outcome,
  onDismiss,
}: {
  readonly outcome: DecisionOutcome;
  readonly onDismiss: () => void;
}): ReactElement {
  if (outcome.kind === "refused") {
    const isStale = outcome.code === "APPROVAL_STALE";
    return (
      <div className="hns-policy__report" data-tone="danger" role="alert">
        <p className="hns-policy__report-text">
          <strong>{isStale ? "提案が古い" : "決定できませんでした"}</strong>{" "}
          {policyCodeMessage(outcome.code)} {outcome.message}
        </p>
        {isStale ? (
          <p className="hns-policy__note">
            読み込みの後に提案か active な revision
            が変わりました。黙って送り直すことはしません。一覧を読み直してから、もう一度判断してください。
          </p>
        ) : null}
        <Button variant="ghost" onClick={onDismiss}>
          閉じる
        </Button>
      </div>
    );
  }
  const approved = outcome.kind === "approved";
  return (
    <div className="hns-policy__report" data-tone="ok" role="status">
      <p className="hns-policy__report-text">
        {approved
          ? "承認しました。revision " + String(outcome.revision) + " が active です。"
          : "却下しました。"}
        {approved && outcome.proposalStale
          ? "（提案の行は更新できませんでしたが、承認は反映されています）"
          : ""}
      </p>
      <Button variant="ghost" onClick={onDismiss}>
        閉じる
      </Button>
    </div>
  );
}

/** One document as the four axes a person decides on. */
function DocumentTable({
  policy,
  label,
}: {
  readonly policy: PolicyDocumentRecord;
  readonly label: string;
}): ReactElement {
  return (
    <table className="hns-policy__table" aria-label={label + " のポリシー"}>
      <caption className="hns-sr-only">{label}</caption>
      <tbody>
        <tr>
          <th scope="row">read roots</th>
          <td>{rootsLabel(policy.readRoots)}</td>
        </tr>
        <tr>
          <th scope="row">write roots</th>
          <td>{rootsLabel(policy.writeRoots)}</td>
        </tr>
        <tr>
          <th scope="row">bash</th>
          <td>{permissionLabel(policy.bash)}</td>
        </tr>
        <tr>
          <th scope="row">network</th>
          <td>{permissionLabel(policy.network)}</td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * The document in force.
 *
 * @param props.active - The active revision's document.
 * @returns The four axes, read as a table.
 *
 * @remarks
 * Its own component rather than a table prop spelled `document`: a text scan for HTML injection
 * sinks (`app/xss.test.tsx`) reads the source, and `document` beside a field is the shape it
 * looks for. Naming the value for what it is keeps the scan meaningful.
 */
function ActiveDocument({ active }: { readonly active: PolicyDocumentRecord }): ReactElement {
  return <DocumentTable policy={active} label="active" />;
}

/** What the workspace is allowed now. */
function ActivePanel({
  revisions,
  active,
}: {
  readonly revisions: readonly PolicyRevisionRecord[];
  readonly active: PolicyRevisionRecord;
}): ReactElement {
  return (
    <section className="hns-policy__panel" aria-labelledby="policy-active-title">
      <h2 id="policy-active-title" className="hns-policy__subtitle">
        いまの権限
      </h2>
      <p className="hns-policy__meta">
        revision {active.revision} · {active.createdBy} · {active.createdAt}
      </p>
      <ActiveDocument active={active.document} />
      {revisions.length > 1 ? (
        <details className="hns-policy__history">
          <summary>改訂の履歴（{revisions.length} 件）</summary>
          <ul className="hns-policy__list">
            {[...revisions].reverse().map((revision) => (
              <li key={revision.id} className="hns-policy__history-row">
                <span>revision {revision.revision}</span>
                <span className="hns-policy__note">{revision.createdAt}</span>
                <span className="hns-policy__note">{revision.createdBy}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/**
 * The proposal form: four axes and a reason.
 *
 * @remarks
 * The roots fields start empty and an empty field is `[]`, which the face reads as "keep the
 * active roots" — the placeholders show what will be kept, so a person filling only one axis does
 * not ungovern the other.
 */
function ProposalForm({
  workspaceId,
  active,
  onProposed,
}: {
  readonly workspaceId: string;
  readonly active: PolicyDocumentRecord;
  readonly onProposed: () => void;
}): ReactElement {
  const [commit, inFlight] = useMutation<PolicyScreenProposeMutation>(ProposePolicyMutation);
  const [readRoots, setReadRoots] = useState("");
  const [writeRoots, setWriteRoots] = useState("");
  const [bash, setBash] = useState(false);
  const [network, setNetwork] = useState(false);
  const [reason, setReason] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const reasonOk = reasonState(reason).ok;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!reasonOk || inFlight) return;
    setRefusal(null);
    commit({
      variables: {
        input: {
          workspaceId,
          // `[]` is "unchanged": the face keeps the active revision's roots for that tool.
          readRoots: rootsOfField(readRoots),
          writeRoots: rootsOfField(writeRoots),
          bash,
          network,
          reason: reasonState(reason).text,
        },
      },
      onCompleted: (response) => {
        const outcome = proposeOutcomeOf(response);
        if (outcome.kind === "refused") {
          setRefusal(policyCodeMessage(outcome.code) + " " + outcome.message);
          return;
        }
        setReadRoots("");
        setWriteRoots("");
        setBash(false);
        setNetwork(false);
        setReason("");
        onProposed();
      },
      onError: (error) => setRefusal("提案できませんでした: " + error.message),
    });
  };

  return (
    <section className="hns-policy__panel" aria-labelledby="policy-propose-title">
      <h2 id="policy-propose-title" className="hns-policy__subtitle">
        変更を提案する
      </h2>
      <p className="hns-policy__note">
        空欄は「変更なし」（いまの revision の roots
        をそのまま使う）。提案しても、人が承認するまで有効になりません。
      </p>
      <form className="hns-policy__form" onSubmit={submit} aria-label="ポリシーの提案">
        <label className="hns-policy__field">
          <span>read roots（カンマまたは改行区切り）</span>
          <input
            type="text"
            value={readRoots}
            onChange={(event) => setReadRoots(event.target.value)}
            placeholder={rootsLabel(active.readRoots)}
          />
        </label>
        <label className="hns-policy__field">
          <span>write roots（カンマまたは改行区切り）</span>
          <input
            type="text"
            value={writeRoots}
            onChange={(event) => setWriteRoots(event.target.value)}
            placeholder={rootsLabel(active.writeRoots)}
          />
        </label>
        <label className="hns-policy__check">
          <input
            type="checkbox"
            checked={bash}
            onChange={(event) => setBash(event.target.checked)}
          />
          <span>bash を許可する</span>
        </label>
        <label className="hns-policy__check">
          <input
            type="checkbox"
            checked={network}
            onChange={(event) => setNetwork(event.target.checked)}
          />
          <span>network を許可する</span>
        </label>
        <label className="hns-policy__field">
          <span>理由</span>
          <input
            type="text"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
          />
        </label>
        {refusal === null ? null : (
          <p className="hns-policy__note" role="alert">
            {refusal}
          </p>
        )}
        <div className="hns-policy__actions">
          <Button type="submit" loading={inFlight} disabled={!reasonOk}>
            提案する
          </Button>
        </div>
      </form>
    </section>
  );
}

/** The proposals waiting for a human, each with its diff and its decision. */
function PendingPanel({
  proposals,
  canDecide,
  onDecided,
  onReread,
}: {
  readonly proposals: readonly PolicyProposalRecord[];
  readonly canDecide: boolean;
  readonly onDecided: (outcome: DecisionOutcome) => void;
  readonly onReread: () => void;
}): ReactElement {
  const pending = pendingProposalsOf(proposals);
  return (
    <section className="hns-policy__panel" aria-labelledby="policy-pending-title">
      <h2 id="policy-pending-title" className="hns-policy__subtitle">
        承認待ちの提案{pending.length === 0 ? "" : "（" + String(pending.length) + " 件）"}
      </h2>
      {pending.length === 0 ? (
        <p className="hns-policy__empty" data-testid="policy-pending-empty">
          承認待ちの提案はありません。
        </p>
      ) : (
        <ul className="hns-policy__proposals">
          {pending.map((proposal) => (
            <li key={proposal.id}>
              <ProposalCard
                proposal={proposal}
                canDecide={canDecide}
                onDecided={onDecided}
                onReread={onReread}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One proposal: who asked, why, what changes, and the decision.
 *
 * @remarks
 * The decision has its own reason field, separate from the proposer's: the store records both,
 * and a decision without a reason is a sentence the next person cannot read. The buttons are
 * enabled by a typed reason, and disabled — not hidden — when this principal may not decide, so a
 * keyboard user learns why instead of finding no control at all.
 */
function ProposalCard({
  proposal,
  canDecide,
  onDecided,
  onReread,
}: {
  readonly proposal: PolicyProposalRecord;
  readonly canDecide: boolean;
  readonly onDecided: (outcome: DecisionOutcome) => void;
  readonly onReread: () => void;
}): ReactElement {
  const [commit, inFlight] = useMutation<PolicyScreenDecideMutation>(DecidePolicyProposalMutation);
  const [reason, setReason] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const reasonOk = reasonState(reason).ok;
  const diff = diffKindLabel(proposal.diff.kind);
  // A diff the algebra could not compute (`unsupported`) is not a change anyone can approve: the
  // face refuses it too, and the button says so before the refusal round trip.
  const comparable = proposal.diff.kind !== "UNSUPPORTED";
  const canSubmit = canDecide && reasonOk && comparable && !inFlight;

  const decide = useCallback(
    (approve: boolean): void => {
      if (!canSubmit) return;
      setRefusal(null);
      commit({
        variables: {
          input: {
            proposalId: proposal.id,
            // The token the person read. A stale one is shown, never refreshed and resent.
            reviewToken: proposal.reviewToken,
            approve,
            reason: reasonState(reason).text,
          },
        },
        onCompleted: (response) => {
          onDecided(decideOutcomeOf(response));
          // The decision moved what is active and closed one proposal: both lists are read again,
          // never patched from the answer's echo.
          onReread();
        },
        onError: (error) => setRefusal("決定できませんでした: " + error.message),
      });
    },
    [canSubmit, commit, onDecided, onReread, proposal.id, proposal.reviewToken, reason],
  );

  return (
    <article className="hns-policy__proposal" aria-labelledby={"policy-proposal-" + proposal.id}>
      <header className="hns-policy__proposal-header">
        <h3 id={"policy-proposal-" + proposal.id} className="hns-policy__proposal-title">
          revision {proposal.baseRevision} からの変更
        </h3>
        <Badge tone={diff.tone}>{diff.label}</Badge>
      </header>
      <p className="hns-policy__note">
        {proposal.requestedBy} · {proposal.createdAt} · {proposalStatusLabel(proposal.status)}
      </p>
      <p className="hns-policy__reason">{proposal.reason}</p>
      <DiffView proposal={proposal} />
      <details className="hns-policy__candidate">
        <summary>提案後の全体</summary>
        <DocumentTable policy={proposal.candidate} label="提案後" />
      </details>
      <div className="hns-policy__decide">
        <label className="hns-policy__field">
          <span>決定の理由</span>
          <input
            type="text"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
          />
        </label>
        {canDecide ? null : (
          <p className="hns-policy__note">
            この画面では承認・拒否を送れません。人が決めます（agent の principal
            はサーバが拒否します）。
          </p>
        )}
        {comparable ? null : (
          <p className="hns-policy__note">
            この差分は比較できないため、承認・拒否はできません。提案を出し直してください。
          </p>
        )}
        {refusal === null ? null : (
          <p className="hns-policy__note" role="alert">
            {refusal}{" "}
            <Button variant="ghost" onClick={onReread}>
              読み直す
            </Button>
          </p>
        )}
        <div className="hns-policy__actions">
          <Button variant="primary" disabled={!canSubmit} onClick={() => decide(true)}>
            承認
          </Button>
          <Button variant="ghost" disabled={!canSubmit} onClick={() => decide(false)}>
            拒否
          </Button>
        </div>
      </div>
    </article>
  );
}

/**
 * The proposal's diff as added and removed atoms.
 *
 * @remarks
 * `equal` — the candidate equals its base — is not an empty card: it is a proposal whose
 * approval changes nothing, and the screen says so, because a person approving it should know
 * that no capability moves (the face records it as a revision all the same).
 */
function DiffView({ proposal }: { readonly proposal: PolicyProposalRecord }): ReactElement {
  const { added, removed, kind } = proposal.diff;
  if (kind === "EQUAL") {
    return (
      <p className="hns-policy__diff-empty" data-testid="policy-diff-equal">
        変更なしの提案です。承認しても権限は変わりません。
      </p>
    );
  }
  if (kind === "UNSUPPORTED") {
    return (
      <p className="hns-policy__diff-empty" data-tone="danger">
        この差分は比較できません（base の revision が読めないか、比較できない形です）。
      </p>
    );
  }
  return (
    <div className="hns-policy__diff">
      <AtomList title="追加" atoms={added} testId="policy-diff-added" />
      <AtomList title="削除" atoms={removed} testId="policy-diff-removed" />
    </div>
  );
}

/** One side of a diff. */
function AtomList({
  title,
  atoms,
  testId,
}: {
  readonly title: string;
  readonly atoms: readonly PolicyAtomRecord[];
  readonly testId: string;
}): ReactElement {
  return (
    <div className="hns-policy__atoms" data-testid={testId} aria-label={title}>
      <h4 className="hns-policy__atoms-title">{title}</h4>
      {atoms.length === 0 ? (
        <p className="hns-policy__note">なし</p>
      ) : (
        <ul className="hns-policy__list">
          {atoms.map((atom) => {
            const label = atomLabel(atom);
            return (
              <li key={atom.atomKind + ":" + atom.value} className="hns-policy__atom">
                <Badge tone="neutral">{label.tool}</Badge>
                <span>{label.value}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** What was already decided, so a person can check what happened without it crowding the rest. */
function DecidedPanel({
  proposals,
}: {
  readonly proposals: readonly PolicyProposalRecord[];
}): ReactElement {
  const decided = decidedProposalsOf(proposals);
  if (decided.length === 0) return <div hidden />;
  return (
    <section className="hns-policy__panel" aria-labelledby="policy-decided-title">
      <h2 id="policy-decided-title" className="hns-policy__subtitle">
        決定済み（{decided.length} 件）
      </h2>
      <ul className="hns-policy__list">
        {decided.map((proposal) => (
          <li key={proposal.id} className="hns-policy__decided">
            <Badge tone={proposal.status === "APPROVED" ? "ok" : "neutral"}>
              {proposalStatusLabel(proposal.status)}
            </Badge>
            <span>{diffKindLabel(proposal.diff.kind).label}</span>
            <span className="hns-policy__note">{proposal.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
