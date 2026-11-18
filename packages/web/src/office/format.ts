import { PREVIEW_STATUSES } from "@hns/core/office";
import type { OfficeErrorCode, PreviewStatus } from "@hns/core/office";

/**
 * A state as the wire carries one: the contract's seven, plus a member this build does not know.
 *
 * @remarks
 * Relay's generated enum type adds `"%future added value"` because the server may name a state a
 * newer contract has. Such a state is not one the screen can draw; it reads as "結果を確認中",
 * which is true of any state a person did not expect and does not claim to be `ready`.
 */
export type WireStatus = PreviewStatus | Uppercase<PreviewStatus> | "%future added value";

/** A code as the wire carries one: the contract's, in either case, or a member this build lacks. */

/** The contract's state for a wire value; a state this build does not know reads as `stale`. */
export function previewStatusOf(status: WireStatus): PreviewStatus {
  for (const known of PREVIEW_STATUSES) {
    if (known === status || known.toUpperCase() === status) return known;
  }
  return "stale";
}

/**
 * The largest preview the browser is given: 50 MiB of PDF.
 *
 * @remarks
 * The contract's browser ceiling (`docs/office.md` §10). The check runs **before PDF.js is
 * asked for anything**: a document above it is never handed to the viewer, because the cost of
 * refusing late is a tab that stops answering.
 */
export const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;

/**
 * The most pages the browser is given.
 *
 * @remarks
 * The same row of the contract's table as {@link MAX_PREVIEW_BYTES}. A preview with more pages is
 * not loaded either; the panel says which number was exceeded and that the file is intact.
 */
export const MAX_PREVIEW_PAGES = 300;

/** The seven preview states, as the panel names them. */
export const PREVIEW_STATE_LABELS: Readonly<Record<PreviewStatus, string>> = {
  queued: "準備中",
  generating: "準備中",
  stale: "結果を確認中",
  ready: "表示できます",
  failed: "失敗",
  unsupported: "対象外",
  disabled: "未設定",
};

/** One office error code, as the screen reads it: a reason and what to do next. */
export interface ErrorExplanation {
  /** The sentence the panel shows. */
  readonly message: string;
  /** What a person can do; empty when there is nothing to press. */
  readonly advice: string;
}

/**
 * What each office failure means to a person (`docs/office.md` §9).
 *
 * @remarks
 * The vocabulary is closed, so the table is. **The server's own `message` is never shown**: it is
 * English prose for an operator, and it can name paths and engine internals that a person reading
 * a proposal does not need (C3).
 */
export const ERROR_EXPLANATIONS: Readonly<Record<OfficeErrorCode, ErrorExplanation>> = {
  unsupported_format: {
    message: "この形式はプレビューできません",
    advice: "docx・xlsx・pptx のいずれかなら開けます。",
  },
  unsupported_command: { message: "この操作には対応していません", advice: "" },
  input_too_large: {
    message: "ファイルが大きすぎます（上限 50 MB）",
    advice: "原本はそのまま残っています。",
  },
  input_too_large_archive: {
    message: "ファイルの中身が大きすぎます",
    advice: "原本はそのまま残っています。",
  },
  too_many_pages: {
    message: "ページが多すぎます",
    advice: "見たいページを指定してから開いてください。",
  },
  too_many_cells: { message: "ブックが大きすぎます", advice: "原本はそのまま残っています。" },
  too_many_pixels: { message: "画像が大きすぎます", advice: "原本はそのまま残っています。" },
  // Not "the engine is missing": the read cannot tell "no row yet" from "no engine" (the
  // contract has no code for the first), so the sentence says only what this read means.
  engine_unavailable: {
    message: "プレビューを用意できませんでした",
    advice: "エンジンが入っていないか、応答がありません。読み込み直すか、再試行してください。",
  },
  engine_timeout: {
    message: "時間内に変換できませんでした",
    advice: "原本はそのまま残っています。再試行すると、もう一度変換します。",
  },
  engine_failed: {
    message: "変換に失敗しました",
    advice: "原本はそのまま残っています。再試行してください。",
  },
  engine_busy: {
    message: "他の変換が終わるのを待っています",
    advice: "少し待ってから再試行してください。",
  },
  output_too_large: { message: "出力が大きすぎます", advice: "原本はそのまま残っています。" },
  source_changed: {
    message: "ファイルが更新されました",
    advice: "読み込み直すと、新しい内容でプレビューを作ります。",
  },
  not_authorized: {
    message: "このファイルを表示する権限がありません",
    advice: "workspace を選び直してください。",
  },
  cancelled: { message: "プレビューを中止しました", advice: "" },
};

/** The explanation for one code; a code this build does not know reads as a conversion failure. */
export function explainError(code: string): ErrorExplanation {
  const lowered = code.toLowerCase();
  for (const [key, explanation] of Object.entries(ERROR_EXPLANATIONS)) {
    if (key === lowered) return explanation;
  }
  return explainError("engine_failed");
}

/** A preview row, reduced to what the panel decides from. */
export interface PreviewFacts {
  readonly status: WireStatus;
  /** Absent and null are both "no route this screen has" (the wire spells a missing field both ways). */
  readonly url?: string | null | undefined;
  readonly pages?: number | null | undefined;
  readonly bytes?: number | null | undefined;
  readonly error?: { readonly code: string; readonly message: string } | null | undefined;
}

/** What the panel draws: one of the seven states, or why there is no row to draw. */
export type PanelView =
  /** The read answered a failure union member (a path the session may not read, or none). */
  | {
      readonly kind: "failure";
      readonly code: string;
      readonly explanation: ErrorExplanation;
    }
  /** A row exists and names one of the seven states. */
  | {
      readonly kind: "state";
      readonly status: PreviewStatus;
      readonly label: string;
      readonly explanation: ErrorExplanation | null;
    }
  /** `ready`, and the artifact is too large to hand to the viewer. */
  | {
      readonly kind: "too_large";
      readonly reason: "bytes" | "pages";
      readonly message: string;
      readonly advice: string;
    }
  /** `ready` and within the ceiling: the viewer may load `url`. */
  | { readonly kind: "display"; readonly url: string };

/**
 * Decide what one row (or one failure) means to the panel.
 *
 * @param facts - The row's state, its artifact's facts, and its failure.
 * @returns The one thing the panel draws.
 *
 * @remarks
 * **`ready` with no `url` is not a display.** The contract's ready row carries the route its
 * bytes are read at; a ready row without one is a row this screen cannot use, and a made-up URL
 * would be worse than saying so. It reads as `engine_failed`.
 *
 * **The size check runs here, before the viewer exists.** A row above either ceiling never
 * reaches PDF.js; the panel names which number was exceeded and says the file is intact, because
 * a person who sees "too large" must not think the proposal was damaged (C5).
 */
export function panelViewOf(facts: PreviewFacts): PanelView {
  const status = previewStatusOf(facts.status);
  const label = PREVIEW_STATE_LABELS[status];
  switch (status) {
    case "ready": {
      if (facts.bytes !== null && facts.bytes !== undefined && facts.bytes > MAX_PREVIEW_BYTES) {
        return {
          kind: "too_large",
          reason: "bytes",
          message:
            "プレビューが大きすぎます（" +
            mebibytes(facts.bytes) +
            " MB / 上限 " +
            mebibytes(MAX_PREVIEW_BYTES) +
            " MB）",
          advice: "原本はそのまま残っています。ダウンロードして開いてください。",
        };
      }
      if (facts.pages !== null && facts.pages !== undefined && facts.pages > MAX_PREVIEW_PAGES) {
        return {
          kind: "too_large",
          reason: "pages",
          message:
            "ページが多すぎます（" +
            String(facts.pages) +
            " ページ / 上限 " +
            String(MAX_PREVIEW_PAGES) +
            " ページ）",
          advice: "原本はそのまま残っています。見たいページを指定してから開いてください。",
        };
      }
      if (facts.url === null || facts.url === undefined) {
        return { kind: "state", status, label, explanation: explainError("engine_failed") };
      }
      return { kind: "display", url: facts.url };
    }
    case "failed":
      return {
        kind: "state",
        status,
        label,
        explanation: explainError(facts.error == null ? "engine_failed" : facts.error.code),
      };
    case "unsupported":
      return {
        kind: "state",
        status,
        label,
        explanation: explainError(facts.error == null ? "unsupported_format" : facts.error.code),
      };
    case "disabled":
    case "queued":
    case "generating":
    case "stale":
      return { kind: "state", status, label, explanation: null };
    default:
      return {
        kind: "state",
        status: "stale",
        label: PREVIEW_STATE_LABELS.stale,
        explanation: null,
      };
  }
}

/** The same view for a failure union member (a preview the session may not read, or none). */
export function failureViewOf(code: string): PanelView {
  return { kind: "failure", code, explanation: explainError(code) };
}

/**
 * Whether the panel must keep asking: the states an alarm moves on its own.
 *
 * @remarks
 * `stale` is included because the alarm is what settles it: the read says "the result is being
 * checked", and stopping the reads would leave that sentence on screen forever (C6).
 */
export function isPolling(status: WireStatus): boolean {
  const known = previewStatusOf(status);
  return known === "queued" || known === "generating" || known === "stale";
}

/**
 * How long the panel waits between reads while a job is not done, in milliseconds.
 *
 * @remarks
 * One second, for the three states the alarm moves (`docs/office.md` §6). The live socket
 * (`/ws`) is the conversation's and a document panel has no conversation, so polling is the
 * whole of how a change reaches this panel.
 */
export const POLL_INTERVAL_MS = 1000;

/** A byte count in MiB, floored to one decimal place (a ceiling is never rounded up). */
function mebibytes(bytes: number): string {
  const value = Math.floor((bytes / (1024 * 1024)) * 10) / 10;
  return value.toFixed(1);
}

/** A size a person reads: `312 KB` for a small PDF, never `0.0 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return String(Math.max(1, Math.round(bytes / 1024))) + " KB";
  return mebibytes(bytes) + " MB";
}
