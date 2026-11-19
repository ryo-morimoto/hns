import { Suspense, useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useLazyLoadQuery } from "react-relay";
import type { DocumentPanelQuery as DocumentPanelQueryType } from "../__generated__/DocumentPanelQuery.graphql";
import type { DocumentPanelEngineQuery as DocumentPanelEngineQueryType } from "../__generated__/DocumentPanelEngineQuery.graphql";
import { fromGlobalId } from "@hns/core/graphql";
import { Button } from "../components/Button.tsx";
import { formatHash } from "../routes/route.ts";
import { DocumentPanelEngineQuery, DocumentPanelQuery } from "./DocumentPanel.ts";
import {
  POLL_INTERVAL_MS,
  explainError,
  failureViewOf,
  formatSize,
  isPolling,
  panelViewOf,
  type PanelView,
} from "./format.ts";
import { PdfViewer } from "./PdfViewer.tsx";
import { useDocumentRequest } from "./Request.tsx";
import { fileNameOf } from "../app/PanelState.ts";
import "./office.css";

/** The row as the wire carries it (one file at a time). */
type Row = Extract<
  NonNullable<DocumentPanelQueryType["response"]["documentPreview"]>,
  { readonly __typename: "DocumentPreview" }
>;

/** The failure member as the wire carries it. */
type Failure = Extract<
  NonNullable<DocumentPanelQueryType["response"]["documentPreview"]>,
  { readonly __typename: "OfficeFailure" }
>;

/**
 * One file's preview, or the refusal of a file the workspace cannot have.
 *
 * @param props.workspaceId - The workspace the Sidebar selected (the Project global id).
 * @param props.path - The workspace-relative path, or null for a path the route could not read
 * as one (it climbed out of the workspace, or named none).
 * @param props.next - The file after this one in the URL's order, for the "next" control.
 *
 * @remarks
 * **A path the workspace cannot have is still a visit, and it is refused without a request.**
 * The route hands a null path for `..`, an absolute path, and an empty one; the panel draws the
 * refusal as a failure (`not_authorized`: reading outside the workspace is denied, fail closed)
 * and sends nothing to the server, because there is no file to ask about. It does not draw the
 * "nothing is selected" sentence: a person asked for something, and the answer is that it
 * cannot be opened.
 */
export function DocumentPanel({
  workspaceId,
  path,
  next = null,
}: {
  readonly workspaceId: string;
  readonly path: string | null;
  readonly next?: { readonly path: string } | null;
}): ReactElement {
  if (path === null) {
    return (
      <section className="hns-office" aria-label="文書プレビュー">
        <h2 className="hns-office__title" id="office-title" tabIndex={-1}>
          文書プレビュー
        </h2>
        <section
          className="hns-office__state"
          data-office-state="failed"
          data-office-failure="not_authorized"
          data-testid="office-state"
          aria-live="off"
        >
          <h3 className="hns-office__label" data-testid="office-label">
            権限がありません
          </h3>
          <p className="hns-office__message">{explainError("not_authorized").message}</p>
          <p className="hns-office__note">
            このパスは workspace の外を指しています。workspace の中のファイルを開く。
          </p>
        </section>
      </section>
    );
  }
  // A new (workspace, path) is a new visit: keying the panel on it drops every piece of state the
  // previous file held (the read in flight, the request marker, the retry counter) in one render.
  return (
    <PanelFor key={workspaceId + ":" + path} workspaceId={workspaceId} path={path} next={next} />
  );
}

/**
 * One file's preview, in the seven states of the contract.
 *
 * @param props.workspaceId - The workspace the Sidebar selected (the Project global id).
 * @param props.path - The workspace-relative path of the file.
 *
 * @remarks
 * **The screen creates the row.** A read that answers a failure is not "the engine is missing":
 * the contract has no code for "nothing was requested yet", so the first read of a file is
 * followed by `requestDocumentPreview`, which is what turns a file into a `queued` row (or into
 * `unsupported` / `disabled`). Only a failure the request itself answers stays a failure.
 *
 * **Polling, because the panel has no conversation.** While the row is `queued`, `generating`,
 * or `stale`, the panel asks again every {@link POLL_INTERVAL_MS}; the live socket is the
 * conversation's, and a document panel has none. A terminal row is not re-asked in a loop.
 *
 * **A state never runs backwards.** A read that names another `version` than the row on screen is
 * a different document: it replaces the row (and the viewer restarts at page 1).
 *
 * **The row's `url` is re-read on every `ready` answer (0239).** The route a ready row names is
 * the answer's, not a value the panel keeps: a row that becomes ready while the panel holds an
 * older read's version would keep asking the old route and read a `425` (or a `404`) forever.
 * The latest read's url is what the viewer is given, and the viewer is keyed by it.
 */
function PanelFor({
  workspaceId,
  path,
  next,
}: {
  readonly workspaceId: string;
  readonly path: string;
  readonly next: { readonly path: string } | null;
}): ReactElement {
  // Every read is a new query (a new key), so a poll always sees the server's answer.
  // The counter keys the read: every increment is a new request, so a poll always sees the
  // server's answer. It starts at 1 because the first read is the render itself, not a poll.
  const [reads, setReads] = useState(1);
  // A read that follows a poll or a retry asks the server rather than reading the store: the
  // store's answer is the state that was just drawn, and the question is what the row is **now**.
  const [network, setNetwork] = useState(false);
  /** Ask for the row again: a new read is a new key, and the read component is remounted for it. */
  const read = useCallback(() => {
    setNetwork(true);
    setReads((value) => value + 1);
  }, []);

  return (
    <section className="hns-office" aria-label="文書プレビュー" data-office-path={path}>
      <header className="hns-office__header">
        <h2 className="hns-office__title" id="office-title" tabIndex={-1}>
          文書プレビュー
        </h2>
        <p className="hns-office__path" title={path}>
          {path}
        </p>
      </header>
      <Suspense fallback={<Pending />}>
        <Read
          key={String(reads)}
          network={network}
          workspaceId={workspaceId}
          path={path}
          onPoll={read}
          onRetry={() => read()}
        />
      </Suspense>
      {next === null || documentHash(workspaceId, next.path) === null ? null : (
        <nav className="hns-office__nav" aria-label="次のファイル">
          {/*
            The next file is a link, not a button: it is another URL (#/p/<project>/doc/<path>),
            so Back returns to this file and a middle click opens one more.
          */}
          <a
            className="hns-office__next"
            data-testid="office-next"
            href={documentHash(workspaceId, next.path) ?? undefined}
          >
            次のファイル: {fileNameOf(next.path)}
          </a>
        </nav>
      )}
    </section>
  );
}

/**
 * One read, drawn as the state it answered.
 *
 * @remarks
 * The read is the query; the read's state (its request, its refusal) is `Requested`, which is
 * mounted for exactly one read, so the next read starts with none of it.
 */
function Read({
  workspaceId,
  path,
  network,
  onPoll,
  onRetry,
}: {
  readonly workspaceId: string;
  readonly path: string;
  /** Whether this read is a question for the server rather than a read of the store. */
  readonly network: boolean;
  readonly onPoll: () => void;
  readonly onRetry: () => void;
}): ReactElement {
  const data = useLazyLoadQuery<DocumentPanelQueryType>(
    DocumentPanelQuery,
    { workspaceId, path },
    { fetchPolicy: network ? "network-only" : "store-or-network" },
  );
  const answered = data.documentPreview ?? null;
  const row: Row | Failure | null =
    answered !== null &&
    (answered.__typename === "DocumentPreview" || answered.__typename === "OfficeFailure")
      ? answered
      : null;
  return (
    <Requested workspaceId={workspaceId} path={path} row={row} onPoll={onPoll} onRetry={onRetry} />
  );
}

/** One read's request: asked for when the read found no row, drawn until the next read. */
function Requested({
  workspaceId,
  path,
  row,
  onPoll,
  onRetry,
}: {
  readonly workspaceId: string;
  readonly path: string;
  readonly row: Row | Failure | null;
  readonly onPoll: () => void;
  readonly onRetry: () => void;
}): ReactElement {
  // **The request is the first read's follow-up.** A read that found no row means nothing was
  // requested for this file (the contract has no code for that), so the panel asks for it; the
  // answer is drawn until the alarm's poll replaces it. This component asks once, in an effect
  // (not in the render), and only for a failure member: a row that exists is never re-requested.
  const request = useDocumentRequest();
  const [refusal, setRefusal] = useState<string | null>(null);
  const [requested, setRequested] = useState<Row | null>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (row === null || row.__typename !== "OfficeFailure" || asked.current) return;
    asked.current = true;
    void request({ workspaceId, path }).then((answer) => {
      if (!answer.ok) setRefusal(answer.code);
      else setRequested(answer.row);
    });
  }, [path, request, row, workspaceId]);

  // The row on screen: the request's answer, or the read's.
  // **The latest row wins, and it is the read's when the read answers one.** The request's answer
  // is drawn only until a read replaces it: a poll that answers `ready` carries the url this
  // preview is read at now, and keeping the request's older row would keep the older url (0239).
  const read = row !== null && row.__typename === "DocumentPreview" ? row : null;
  const shown: Row | null = read ?? requested;

  // A read whose row the alarm may still move is read again a second later.
  //
  // The status comes from what is **drawn**, not from the read: the first read of a file finds no
  // row and the request is what writes `queued`, so a timer keyed on the read's status alone was
  // never set — the panel asked once and then stopped, until the person reloaded. A row the
  // request answered is the same row a poll would read, so it polls too.
  const readStatus = shown === null ? null : shown.status;
  useEffect(() => {
    if (readStatus === null || !isPolling(readStatus)) return;
    const timer = setTimeout(onPoll, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [onPoll, readStatus]);

  // A read that found no row is not a failure to draw: nothing was requested yet, and the
  // request is what says whether there is a state to show. The panel says so meanwhile.
  if (refusal === null && shown === null) {
    return (
      <section
        className="hns-office__state"
        data-office-state="queued"
        data-testid="office-state"
        aria-busy="true"
        aria-live="polite"
      >
        <span className="hns-office__spinner" data-testid="office-spinner" aria-hidden="true" />
        <h3 className="hns-office__label" data-testid="office-label">
          準備中
        </h3>
        <p className="hns-office__message">プレビューを要求しています…</p>
      </section>
    );
  }
  const view: PanelView =
    refusal !== null
      ? failureViewOf(refusal)
      : shown === null
        ? failureViewOf("engine_unavailable")
        : panelViewOf(shown);
  return <PanelBody view={view} facts={shown} onRetry={onRetry} onExit={focusTitle} />;
}

/**
 * The hash one file is opened at, in the shell's own spelling.
 *
 * @param path - The workspace-relative path.
 * @returns `#/p/<project>/doc/<path>`, with the path's segments encoded one by one.
 *
 * @remarks
 * The project is this panel's workspace, read back from the global id the panel was given: the
 * panel opens files in the workspace it draws, so the next file cannot be another project's.
 */
function documentHash(workspaceId: string, path: string): string | null {
  const decoded = fromGlobalId(workspaceId);
  return decoded.ok ? formatHash({ kind: "file", projectId: decoded.value.id, path }) : null;
}

/** Where a viewer's `Escape` puts focus: the panel's header, so the next Tab leaves the panel. */
function focusTitle(): void {
  document.getElementById("office-title")?.focus();
}

/** What one state is: the viewer, or a sentence and the way forward. */
function PanelBody({
  view,
  facts,
  onRetry,
  onExit,
}: {
  readonly view: PanelView;
  readonly facts: Row | null;
  readonly onRetry: () => void;
  readonly onExit: () => void;
}): ReactElement {
  if (view.kind === "display") {
    return (
      // Keyed by the url itself: a ready row whose route changed (a new version, or the first
      // read that carried one) is a new document to the reader, and the viewer must restart on it.
      <PdfViewer
        key={view.url}
        url={view.url}
        expectedPages={facts?.pages ?? null}
        onExit={onExit}
      />
    );
  }
  return <StateView view={view} facts={facts} onRetry={onRetry} />;
}

/** A spinner and a sentence, for a read that has not answered yet. */
function Pending(): ReactElement {
  return (
    <div className="hns-office__pending" aria-busy="true" data-testid="office-pending">
      <span className="hns-office__spinner" aria-hidden="true" />
      <span>読み込み中</span>
    </div>
  );
}

/**
 * One state, drawn as what it is, what it means, and what to do next.
 *
 * @remarks
 * The sentences are the table's (`docs/office.md` §9), never the server's message: that is an
 * operator's English and can name a path or an engine the reader does not need (C3). Every state
 * that is not moving on its own offers the retry, because each failure in the table ends with
 * something a person can do.
 */
function StateView({
  view,
  facts,
  onRetry,
}: {
  readonly view: Exclude<PanelView, { readonly kind: "display" }>;
  readonly facts: Row | null;
  readonly onRetry: () => void;
}): ReactElement {
  const status =
    view.kind === "failure" ? "failed" : view.kind === "too_large" ? "failed" : view.status;
  // A refusal is not one of the job's states: `data-office-failure` names it, so a test (and a
  // screen reader's summary) can tell "this file failed" from "you may not read this file".
  const refusal = view.kind === "failure" ? view.code : null;
  const label =
    view.kind === "failure"
      ? view.code === "not_authorized"
        ? "権限がありません"
        : "失敗"
      : view.kind === "too_large"
        ? "大きすぎます"
        : view.label;
  const explanation =
    view.kind === "failure"
      ? view.explanation
      : view.kind === "too_large"
        ? { message: view.message, advice: view.advice }
        : (view.explanation ?? explainError("engine_failed"));
  const busy = status === "queued" || status === "generating" || status === "stale";
  return (
    <section
      className="hns-office__state"
      data-office-state={status}
      data-office-failure={refusal ?? undefined}
      data-testid="office-state"
      aria-busy={busy}
      aria-live={busy ? "polite" : "off"}
    >
      {busy ? (
        <span className="hns-office__spinner" data-testid="office-spinner" aria-hidden="true" />
      ) : null}
      <h3 className="hns-office__label" data-testid="office-label">
        {label}
      </h3>
      <p className="hns-office__message">{explanation.message}</p>
      {explanation.advice === "" ? null : <p className="hns-office__note">{explanation.advice}</p>}
      {status === "disabled" ? <SetupGuide /> : null}
      {facts === null || facts.bytes === null || facts.bytes === undefined ? null : (
        <p className="hns-office__facts" data-testid="office-facts">
          {facts.pages === null || facts.pages === undefined
            ? ""
            : String(facts.pages) + " ページ · "}
          {formatSize(facts.bytes)}
        </p>
      )}
      {busy ? null : (
        <Button variant="ghost" onClick={onRetry}>
          再試行
        </Button>
      )}
    </section>
  );
}

/**
 * What to do when this deployment runs no office engine.
 *
 * @remarks
 * The steps are an operator's (`docs/office.md` §11): install a pack whose manifest declares the
 * format, and point the machine at it with `HNS_OFFICE_PACK`. The panel cannot do either, so it
 * says where they are rather than offering a button that would not help; the engine probe says
 * which part is missing, and only when it is asked for.
 */
function SetupGuide(): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="hns-office__setup" data-testid="office-setup">
      <p>Office プレビューは未設定です。次のどれかで有効になります。</p>
      <ol>
        <li>machine に Office の pack を置き、HNS_OFFICE_PACK を pack のディレクトリに向ける。</li>
        <li>pack の manifest に docx・xlsx・pptx のいずれかが載っていることを確かめる。</li>
        <li>このパネルで「再試行」を押す。pack を置いた後は、新しいプレビューが作られる。</li>
      </ol>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        エンジンの状態を確かめる
      </Button>
      {open ? (
        <Suspense fallback={<p className="hns-office__note">問い合わせています…</p>}>
          <EngineProbe />
        </Suspense>
      ) : null}
    </div>
  );
}

/**
 * The engine probe's answer: the engine, why it is absent, or that it could not be asked.
 *
 * @remarks
 * The probe names no workspace: it is a diagnosis of the deployment, not of one file. A failure
 * member is "could not ask", never "the engine is missing": only `OfficeEngineUnavailable` is
 * the latter.
 */
function EngineProbe(): ReactElement {
  const data = useLazyLoadQuery<DocumentPanelEngineQueryType>(DocumentPanelEngineQuery, {});
  const engine = data.officeEngine;
  // **The machine's reason is not shown.** It is written for an operator and can name a path on
  // the machine, a pack directory, or a driver; what a person reading a document needs is which
  // part is missing, which is the sentence the panel already gives.
  const text =
    engine.__typename === "OfficeEngineAvailable"
      ? "エンジン: " + engine.id + " " + engine.version
      : engine.__typename === "OfficeEngineUnavailable"
        ? "エンジンがありません（pack の導入が必要です）。"
        : "エンジンの状態を問い合わせできませんでした。";
  return (
    <p className="hns-office__note" data-testid="office-engine">
      {text}
    </p>
  );
}
