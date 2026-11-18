import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { RelayEnvironmentProvider } from "react-relay";
import * as v from "valibot";
import { expect, test } from "vitest";
import { toGlobalId } from "@hns/core/graphql";
import { createEnvironment } from "../relay/environment.ts";
import { answerWith } from "../../test/support/officeFace.ts";
import { officeFailure, previewRow, type PreviewRow } from "../../test/support/officeWire.ts";
import { DocumentPanel } from "./DocumentPanel.tsx";
import queryOperation from "../__generated__/DocumentPanelQuery.graphql.ts";
import requestOperation from "../__generated__/RequestMutation.graphql.ts";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** One request the app's network sends: the operation's text and its variables (all strings). */
const BODY = v.object({
  query: v.string(),
  variables: v.record(v.string(), v.string()),
});

/** The project the Sidebar selected, and the workspace the server keys previews by. */
const PROJECT = "project-1";
const WORKSPACE = toGlobalId("Project", PROJECT);
const PATH = "提案書.docx";
const URL_OF =
  "/api/office/preview?workspaceId=project-1&path=%E6%8F%90%E6%A1%88%E6%9B%B8.docx&v=sha256:0";

/** What one request the panel made was, as the server would read it. */
interface Sent {
  readonly operation: string;
  /** The operation's variables, as the request carried them (two strings for every preview). */
  readonly variables: Map<string, string>;
}

/**
 * Harness: the production environment, the published schema, and the panel.
 *
 * @param answers - One answer per request, in order (the last repeats). The panel's polling walks them.
 * @param requested - What `requestDocumentPreview` answers; the default says no row exists yet.
 * @param onRequest - Called when the first request reaches the server, before the answer is given.
 *
 * @remarks
 * The environment is `createEnvironment` (the production one) over a `fetch` that executes each
 * request's text against `packages/web/schema.graphql` through {@link answerWith}: the enum
 * spellings, the union members, and the field sets the panel reads are the contract's, and a
 * request the face could not execute would fail here rather than be answered with a fixture's
 * shape. The panel itself, its operations, and its components are the production's.
 */
/** What a harness hands back: the environment, what it saw, and what the request carried. */
interface Harness {
  readonly environment: ReturnType<typeof createEnvironment>;
  readonly calls: Sent[];
  /** When each read reached the server, in ms since the harness was built. */
  readonly at: number[];
  /** The string variables the panel sent with its request, once it made one. */
  readonly requestedVariables: Record<string, string>;
}

/** One call the harness's server saw. */
type HarnessAnswers = (sent: Sent, index: number) => PreviewRow;

function harness(
  answers: HarnessAnswers,
  // The default request answers no row at all: a read-only test is never shown a state the
  // request made up.
  requested: PreviewRow | null = null,
): Harness {
  const sent: Sent[] = [];
  const requestedVariables: Record<string, string> = {};
  let requestedCount = 0;
  let readIndex = 0;
  const start = Date.now();
  const at: number[] = [];
  const operationOf = (text: string): string =>
    /\b(?:query|mutation)\s+([A-Za-z0-9_]+)/u.exec(text)?.[1] ?? "";
  const environment = createEnvironment({
    fetch: async (_input, init) => {
      // The body is the app's own `/graphql` request; it is parsed at this boundary like any other
      // external value.
      const sentBody = v.parse(BODY, JSON.parse(String(init?.body ?? "{}")));
      const text = sentBody.query;
      const variables = new Map(Object.entries(sentBody.variables));
      const operation = operationOf(text);
      sent.push({ operation, variables });
      const readAt = readIndex;
      if (operation === "DocumentPanelQuery") {
        at.push(Date.now() - start);
        readIndex += 1;
      }
      if (operation === "RequestMutation") {
        for (const [key, value] of variables) requestedVariables[key] = value;
      }
      const row =
        operation === "DocumentPanelQuery"
          ? answers({ operation, variables }, readAt)
          : operation === "RequestMutation"
            ? (requested ?? undefined)
            : undefined;
      if (operation === "RequestMutation") requestedCount += 1;
      if (row === undefined || row === null) {
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const data = await answerWith(
        {
          operation,
          variables: Object.fromEntries(variables),
          query: text,
        },
        row,
      );
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { environment, calls: sent, at, requestedVariables };
}

/** Render the panel over an environment. */
function renderPanel(environment: ReturnType<typeof createEnvironment>) {
  return renderPanelWith(environment, PATH);
}

/** Render the panel over an environment, for one file. */
function renderPanelWith(environment: ReturnType<typeof createEnvironment>, path: string) {
  // SAFETY: the element is a JSX tree; `ReactElement` is what `render` takes.
  return render(
    (
      <RelayEnvironmentProvider environment={environment}>
        <DocumentPanel workspaceId={WORKSPACE} path={path} />
      </RelayEnvironmentProvider>
    ) as ReactElement,
  );
}

/** How many requests one operation sent. */
function countOf(calls: readonly Sent[], operation: string): number {
  return calls.filter((call) => call.operation === operation).length;
}

/** The state the panel is drawing. */
function state(): HTMLElement {
  return screen.getByTestId("office-state");
}

/**
 * C1: the seven states, one row each.
 *
 * @remarks
 * The table names what the panel must show for every state of the contract: a screen that lost a
 * branch, or drew one state's sentence for another, fails on its own row.
 */
const TABLE: readonly {
  readonly name: string;
  readonly row: PreviewRow;
  readonly drawing: string;
  readonly text: readonly string[];
  readonly spinner: boolean;
}[] = [
  { name: "queued", row: previewRow("QUEUED"), drawing: "queued", text: ["準備中"], spinner: true },
  {
    name: "generating",
    row: previewRow("GENERATING"),
    drawing: "generating",
    text: ["準備中"],
    spinner: true,
  },
  {
    name: "stale",
    row: previewRow("STALE"),
    drawing: "stale",
    text: ["結果を確認中"],
    spinner: true,
  },
  {
    name: "failed",
    row: previewRow("FAILED", { code: "ENGINE_TIMEOUT" }),
    drawing: "failed",
    text: ["失敗", "時間内に変換できませんでした"],
    spinner: false,
  },
  {
    name: "unsupported",
    row: previewRow("UNSUPPORTED", { code: "UNSUPPORTED_FORMAT" }),
    drawing: "unsupported",
    text: ["対象外", "この形式はプレビューできません", "docx・xlsx・pptx のいずれかなら開けます。"],
    spinner: false,
  },
  {
    name: "disabled",
    row: previewRow("DISABLED"),
    drawing: "disabled",
    text: ["Office プレビューは未設定です", "HNS_OFFICE_PACK"],
    spinner: false,
  },
];

test.each(TABLE)("C1: a $name row draws its own state", async ({ row, drawing, text, spinner }) => {
  const h = harness(() => row);
  renderPanel(h.environment);
  await waitFor(() => expect(state().dataset["officeState"]).toBe(drawing));
  for (const sentence of text) {
    expect(within(state()).getByText(sentence, { exact: false })).toBeTruthy();
  }
  expect(within(state()).queryByTestId("office-spinner") !== null).toBe(spinner);
  expect(state().getAttribute("aria-busy")).toBe(spinner ? "true" : "false");
});

// Catches: a state's own sentence replaced by the server's operator prose.
test("C1: a failed row never shows the server's message", async () => {
  const h = harness(() => previewRow("FAILED", { code: "ENGINE_FAILED" }));
  renderPanel(h.environment);
  await waitFor(() => expect(state().dataset["officeState"]).toBe("failed"));
  expect(within(state()).getByText("変換に失敗しました")).toBeTruthy();
  expect(document.body.textContent ?? "").not.toContain("operator-only prose");
});

// Catches: a size failure drawn as 対象外 (the two classifications the contract keeps apart).
test("C1: a size failure is 失敗 with its code", async () => {
  const h = harness(() => previewRow("FAILED", { code: "INPUT_TOO_LARGE" }));
  renderPanel(h.environment);
  await waitFor(() => expect(state().dataset["officeState"]).toBe("failed"));
  expect(within(state()).getByTestId("office-label").textContent).toBe("失敗");
  expect(within(state()).getByText("ファイルが大きすぎます（上限 50 MB）")).toBeTruthy();
});

test("C5: a ready row over 50 MiB is drawn as too large, and the viewer never mounts", async () => {
  const h = harness(() =>
    previewRow("READY", { url: URL_OF, bytes: 50 * 1024 * 1024 + 1, pages: 10 }),
  );
  renderPanel(h.environment);
  await waitFor(() => expect(state().dataset["officeState"]).toBe("failed"));
  expect(within(state()).getByText(/プレビューが大きすぎます/u)).toBeTruthy();
  expect(within(state()).getByText(/原本はそのまま残っています/u)).toBeTruthy();
  expect(screen.queryByRole("group", { name: "PDF プレビュー" })).toBe(null);
});

test("C5: a ready row over 300 pages is drawn as too large, and the viewer never mounts", async () => {
  const h = harness(() => previewRow("READY", { url: URL_OF, bytes: 1024, pages: 301 }));
  renderPanel(h.environment);
  await waitFor(() => screen.getByText(/ページが多すぎます（301 ページ/u));
  expect(screen.queryByRole("group", { name: "PDF プレビュー" })).toBe(null);
});

/**
 * C3: a refusal is a sentence, and asking again does not make it one more.
 *
 * Catches: the read's failure shown as "the engine is missing" (the contract's hole), the
 * server's message surfaced, or a refusal retried in a loop.
 */
test("C3: not_authorized is a permission sentence, carries no server prose, and is not retried", async () => {
  const h = harness(() => officeFailure("NOT_AUTHORIZED"), officeFailure("NOT_AUTHORIZED"));
  renderPanel(h.environment);
  await waitFor(() => expect(state().dataset["officeState"]).toBe("failed"));
  expect(within(state()).getByTestId("office-label").textContent).toBe("権限がありません");
  expect(within(state()).getByText("このファイルを表示する権限がありません")).toBeTruthy();
  const text = document.body.textContent ?? "";
  expect(text).not.toContain("operator-only prose");
  await waitFor(() => expect(countOf(h.calls, "RequestMutation")).toBe(1));
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(countOf(h.calls, "RequestMutation")).toBe(1);
});

/**
 * C6: a row the alarm is settling moves on by itself.
 *
 * Catches: the poll not running for stale (the sentence would stay forever), a poll that keeps
 * going after the row is terminal, and a poll interval other than the contract's one second.
 */
test("C6: a stale row is re-read a second later and the panel switches to ready", async () => {
  const at: number[] = [];
  const h = harness((sent, index) => {
    // The panel's own read is the first one; after the poll the stale row became ready.
    if (sent.operation === "DocumentPanelQuery" && index === 0) {
      at.push(Date.now());
      return previewRow("STALE");
    }
    at.push(Date.now());
    return previewRow("READY", { url: URL_OF, bytes: 2048, pages: 1 });
  }, previewRow("STALE"));
  renderPanel(h.environment);
  await waitFor(() => expect(state().dataset["officeState"]).toBe("stale"));
  // The next read is a second away, and nothing before it.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(countOf(h.calls, "DocumentPanelQuery")).toBe(1);
  await waitFor(() => expect(countOf(h.calls, "DocumentPanelQuery")).toBe(2), { timeout: 3000 });
  expect((at[1] ?? 0) - (at[0] ?? 0)).toBeGreaterThanOrEqual(950);
  // The row is ready: what is on screen is the viewer, and the reads stop.
  await waitFor(() => expect(screen.getByRole("group", { name: "PDF プレビュー" })).toBeTruthy());
  const settled = countOf(h.calls, "DocumentPanelQuery");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(countOf(h.calls, "DocumentPanelQuery")).toBe(settled);
});

/**
 * C1: a read that found nothing is not a failure to show — the screen asks for the row.
 *
 * Catches: the panel drawing "engine_unavailable" for a file nobody asked about (the contract's
 * hole), and a request that does not carry the selected workspace (which is `not_authorized`).
 */
test("C1: a read that finds no row asks for one, with the selected workspace", async () => {
  // Reads keep answering "no row": the request's answer is drawn, and a second read that still
  // has no row must not ask again (the request count below would catch a loop).
  const h = harness(() => officeFailure("ENGINE_UNAVAILABLE"), previewRow("QUEUED"));
  renderPanel(h.environment);
  await waitFor(() => expect(state().dataset["officeState"]).toBe("queued"));
  expect(countOf(h.calls, "RequestMutation")).toBe(1);
  expect(h.requestedVariables).toStrictEqual({ workspaceId: WORKSPACE, path: PATH });
});

// Catches: the retry doing nothing, or not asking the server again.
// The retry is a new read; a row that exists is never asked for (a request is what creates one, and
// it is an alarm and an audit event).
test("C1: the retry does not ask for a row that exists", async () => {
  const user = userEvent.setup();
  const h = harness(() => previewRow("FAILED", { code: "ENGINE_FAILED" }));
  renderPanel(h.environment);
  await waitFor(() => expect(state().dataset["officeState"]).toBe("failed"));
  await user.click(within(state()).getByRole("button", { name: "再試行" }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(countOf(h.calls, "RequestMutation")).toBe(0);
});

// Catches: a retry that does not reach the server: the click is a new read, and Relay fetches it
// even though the same fields are in the store (a retry is a question, not a memory).
test("C1: a retry asks the server again, and the new state is what is drawn", async () => {
  const user = userEvent.setup();
  const h = harness((_sent, index) =>
    index === 0 ? previewRow("FAILED", { code: "ENGINE_FAILED" }) : previewRow("QUEUED"),
  );
  renderPanel(h.environment);
  await waitFor(() => expect(state().dataset["officeState"]).toBe("failed"));
  await user.click(within(state()).getByRole("button", { name: "再試行" }));
  await waitFor(() => expect(countOf(h.calls, "DocumentPanelQuery")).toBe(2), { timeout: 3000 });
  await waitFor(() => expect(state().dataset["officeState"]).toBe("queued"));
});

// Catches: a second file drawn under the first file's row (its state would carry over).
test("C1: another path starts a new visit and reads its own row", async () => {
  const h = harness(() => previewRow("FAILED", { code: "ENGINE_FAILED" }));
  const { rerender } = renderPanelWith(h.environment, PATH);
  await waitFor(() => expect(state().dataset["officeState"]).toBe("failed"));
  // SAFETY: the element is a JSX tree; `ReactElement` is what `rerender` takes.
  rerender(
    (
      <RelayEnvironmentProvider environment={h.environment}>
        <DocumentPanel workspaceId={WORKSPACE} path="別の提案.docx" />
      </RelayEnvironmentProvider>
    ) as ReactElement,
  );
  await waitFor(() =>
    expect(document.querySelector("[data-office-path]")?.getAttribute("data-office-path")).toBe(
      "別の提案.docx",
    ),
  );
  expect(countOf(h.calls, "DocumentPanelQuery")).toBe(2);
  expect(h.calls[1]?.variables.get("path")).toBe("別の提案.docx");
});

// Catches: a selection, argument, or union member the published schema does not have.
test("the panel's operations are valid against the published schema", async () => {
  const { validate, parse } = await import("graphql");
  const { publishedSchema } = await import("../../test/support/officeFace.ts");
  const schema = publishedSchema();
  const problems = [queryOperation, requestOperation].flatMap((operation) =>
    validate(schema, parse(operation.params.text ?? "")),
  );
  expect(problems.map((error) => error.message)).toStrictEqual([]);
});
