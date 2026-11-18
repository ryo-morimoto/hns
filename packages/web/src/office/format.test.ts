import { expect, test } from "vitest";
import { OFFICE_ERROR_CODES, PREVIEW_STATUSES } from "@hns/core/office";
import {
  ERROR_EXPLANATIONS,
  MAX_PREVIEW_BYTES,
  MAX_PREVIEW_PAGES,
  POLL_INTERVAL_MS,
  PREVIEW_STATE_LABELS,
  explainError,
  isPolling,
  panelViewOf,
  previewStatusOf,
} from "./format.ts";

/**
 * C1 / C3 / C5 at the level below the screen: one row's facts in, one thing to draw out.
 *
 * @remarks
 * Every state of the contract is in the table: the test asserts the panel draws **something for
 * each of the seven** and that the thing fits the state, so a screen that lost a state's branch
 * fails here before it reaches a component test.
 */
const READY = {
  url: "/api/office/preview?workspaceId=w&path=a.docx&v=sha256:0",
  bytes: 1024,
  pages: 2,
};

test("C1: every one of the seven states draws its own thing", () => {
  const states = PREVIEW_STATUSES.map((status) =>
    status === "ready"
      ? panelViewOf({ ...READY, status, error: null })
      : status === "failed"
        ? panelViewOf({
            status,
            url: null,
            pages: null,
            bytes: null,
            error: { code: "engine_timeout", message: "x" },
          })
        : status === "unsupported"
          ? panelViewOf({
              status,
              url: null,
              pages: null,
              bytes: null,
              error: { code: "unsupported_format", message: "x" },
            })
          : panelViewOf({ status, url: null, pages: null, bytes: null, error: null }),
  );
  expect(states.map((view) => view.kind)).toStrictEqual([
    "state", // unsupported
    "state", // disabled
    "state", // queued
    "state", // generating
    "display", // ready
    "state", // failed
    "state", // stale
  ]);
  const byStatus = new Map(
    PREVIEW_STATUSES.map((status, index) => {
      const view = states[index];
      if (view === undefined) throw new Error("every state has a view");
      return [status, view];
    }),
  );
  expect(byStatus.get("unsupported")).toMatchObject({ label: "対象外" });
  expect(byStatus.get("disabled")).toMatchObject({ label: "未設定" });
  expect(byStatus.get("queued")).toMatchObject({ label: "準備中" });
  expect(byStatus.get("generating")).toMatchObject({ label: "準備中" });
  expect(byStatus.get("failed")).toMatchObject({ label: "失敗" });
  expect(byStatus.get("stale")).toMatchObject({ label: "結果を確認中" });
  expect(byStatus.get("ready")).toStrictEqual({ kind: "display", url: READY.url });
});

// Catches: a failure code the panel shows in the wrong state, or a failed row with no code drawn
// as "ready".
test("C1: a failed row explains its code, and an unsupported row explains the format", () => {
  expect(
    panelViewOf({ status: "failed", url: null, error: { code: "engine_timeout", message: "" } }),
  ).toMatchObject({ kind: "state", explanation: { message: "時間内に変換できませんでした" } });
  expect(
    panelViewOf({
      status: "unsupported",
      url: null,
      error: { code: "unsupported_format", message: "" },
    }),
  ).toMatchObject({ kind: "state", explanation: { message: "この形式はプレビューできません" } });
  expect(panelViewOf({ status: "failed", url: null, error: null })).toMatchObject({
    kind: "state",
    explanation: { message: "変換に失敗しました" },
  });
});

/**
 * C3: a refusal is a sentence about the permission, and nothing else.
 *
 * Catches: the server's own message shown to a reader (it names the engine, and can name paths).
 */
test("C3: not_authorized draws the permission sentence and no engine detail", () => {
  const view = panelViewOf({
    status: "failed",
    url: null,
    error: {
      code: "not_authorized",
      message: "workspace project-9 is not this session's (engine ibisoffice 0.8.7)",
    },
  });
  expect(view).toStrictEqual({
    kind: "state",
    status: "failed",
    label: "失敗",
    explanation: {
      message: "このファイルを表示する権限がありません",
      advice: "workspace を選び直してください。",
    },
  });
  const text = JSON.stringify(view);
  expect(text).not.toContain("ibisoffice");
  expect(text).not.toContain("project-9");
});

/**
 * C5: a preview above either ceiling is never handed to the reader.
 *
 * Catches: the 50 MiB check dropped, moved behind the viewer, or turned into ">" from the wrong
 * side (the boundary is the contract's number, and one byte over it is over it).
 */
test("C5: a preview over 50 MiB or over 300 pages is drawn as too large, not as a display", () => {
  const big = panelViewOf({
    status: "ready",
    url: READY.url,
    bytes: MAX_PREVIEW_BYTES + 1,
    pages: 2,
    error: null,
  });
  expect(big).toMatchObject({ kind: "too_large", reason: "bytes" });
  expect(big.kind === "too_large" ? big.message : "").toContain("上限 50.0 MB");
  expect(big.kind === "too_large" ? big.advice : "").toContain("原本はそのまま残っています");
  const many = panelViewOf({
    status: "ready",
    url: READY.url,
    bytes: 1024,
    pages: MAX_PREVIEW_PAGES + 1,
    error: null,
  });
  expect(many).toMatchObject({ kind: "too_large", reason: "pages" });
  // The boundary itself is displayable: the ceiling is the largest accepted, not the first refused.
  expect(
    panelViewOf({
      status: "ready",
      url: READY.url,
      bytes: MAX_PREVIEW_BYTES,
      pages: MAX_PREVIEW_PAGES,
      error: null,
    }),
  ).toStrictEqual({ kind: "display", url: READY.url });
});

// Catches: a ready row with no URL starting a read of nothing (the viewer would load "undefined").
test("C1: a ready row without a URL is a failure, never a display", () => {
  expect(
    panelViewOf({ status: "ready", url: null, bytes: 10, pages: 1, error: null }),
  ).toMatchObject({
    kind: "state",
    status: "ready",
    explanation: { message: "変換に失敗しました" },
  });
});

// Catches: the poll stopped for a state only the alarm can move (C6 would never resolve), or kept
// running for a terminal state.
test("C6: the panel polls exactly the states an alarm moves", () => {
  expect(PREVIEW_STATUSES.filter((status) => isPolling(status))).toStrictEqual([
    "queued",
    "generating",
    "stale",
  ]);
  expect(POLL_INTERVAL_MS).toBe(1000);
});

// Catches: a state the server sends that this build does not know drawn as ready.
test("C1: a state this build does not know reads as 結果を確認中", () => {
  expect(previewStatusOf("%future added value")).toBe("stale");
  expect(previewStatusOf("ready")).toBe("ready");
  expect(panelViewOf({ status: "%future added value", url: READY.url })).toMatchObject({
    kind: "state",
    label: "結果を確認中",
  });
});

// Catches: a code missing its §9 sentence, so a failure draws an unexplained panel.
test("C3: every contract code has a sentence of its own", () => {
  const messages = OFFICE_ERROR_CODES.map((code) => explainError(code).message);
  expect(messages.every((message) => message.length > 0)).toBe(true);
  expect(new Set(messages).size).toBe(OFFICE_ERROR_CODES.length);
  expect(Object.keys(ERROR_EXPLANATIONS).sort()).toStrictEqual([...OFFICE_ERROR_CODES].sort());
  expect(Object.values(PREVIEW_STATE_LABELS)).toHaveLength(PREVIEW_STATUSES.length);
});
