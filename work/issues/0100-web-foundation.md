# 0100: Web の土台（React / Vite / typed client / fixtures）

> 前提変更: 配信は Workers Assets（0160）。typed client と WS の口が増える。

status: done
depends-on: 0037, 0046
touches: packages/web, package.json（tsrs / knip 設定）, package-lock.json, vitest.config.ts, oxlint.config.ts, packages/core/package.json, packages/store/package.json, packages/workspace/package.json, packages/agent/package.json, docs/decisions.md, docs/packages.md, docs/engineering.md, docs/testing.md, README.md, AGENTS.md, work/issues/0101-web-design-system.md

## Goal

packages/web を作り、画面実装が契約とテストの上で進められる状態にする。
React 19 + Vite 8 + TanStack Query 5。HTTP は core の ROUTES / parseResponse だけを使い、
response 型を web で手書きしない。

## Acceptance criteria

- [x] npm install 後、npm run typecheck -w @hns/web / build / test -w @hns/web が通る
- [x] react 19.3.1, react-dom 19.3.1, @tanstack/react-query 5.106.1, vite 8.3.6, @vitejs/plugin-react 6.2.1, @types/react 19.3.0, @types/react-dom 19.3.0, @testing-library/react 16.3.3, @testing-library/user-event 14.6.8, jsdom 31.0.0 を exact pin。理由と pin を D043 に記録
- [x] createWebClient({ baseUrl, fetch }) が ROUTES の path を組み、成功応答を parseResponse で検証する
- [x] HTTP error / network / contract violation を Error 派生の ApiError で返し、status / route / issues を持つ
- [x] 開発用 fixture client があり、server 0035 なしで Workspace 画面を描ける
- [x] jsdom + Testing Library の harness。1本の render テストと、契約違反がテストで落ちる例
- [x] vitest の web project が .tsx と jsdom を扱い、knip の entry が app を拾う
- [x] npm run check が通る

## Notes

- @hns/web は @hns/core にだけ依存（docs/packages.md）。server / agent / store を import しない
- response 型は RouteResponse<K> を使う。エラーは ErrorResponse を parse して ApiError に写す
- Vite の dev proxy は HNS_API（既定 http://127.0.0.1:8787）へ。fixture は VITE_HNS_FIXTURES=1
- 依存追加は D043 に exact pin と理由を書く
- src/api は transport と client を分け、client のテストは fetch を差し替える
- 技術選定の参考: X の記事（2026-11-04）。Vite 8 は Rolldown。named export / barrel なし、境界は parse、UI テストは jsdom + Testing Library（D043）。
- ~~Relay + GraphQL と SSR / streaming は採らない。~~ **D055（2026-11-10）で Relay + GraphQL を採用。** typed client は REST 面（passkey / hooks / 運用 / マシン）に残し、アプリの読み書きは 0175–0182 で GraphQL にする。SSR / streaming の不採用は維持。
- 型検査は tsrs 0.22.0-ts7.1.0-beta（D044）。宣言の emit は tsc のまま。
- Base UI（`@base-ui/react` 1.9.0）は 0101 で追加する。0100 では未使用の依存を作らない。

## やらないこと

- 画面の実装（0101–0112）
- 実 server 0035 の起動・E2E（0043）
- CodeMirror（0106）

## Log

- 2026-11-07: 作成（user）。
- 2026-11-10: D055 により Relay + GraphQL を採用。0100 の typed client / fixtures は REST 面と画面状態に残る。
- 2026-11-07: X の記事（2026-11-04）を技術選定の根拠にして D043 を補い、D044（tsrs）を追加。typed client（ROUTES の path 組み立て / parseResponse / ApiError）、fixture client、Workspace harness、jsdom + Testing Library の12テストを実装。Base UI は 0101 で追加する。
- 2026-11-10: 0188 で typed client・fixture client・REST 契約を削除。shell は `WorkspaceSource`（fixture 実装）で読む。D055 / D059。

## Result

- verdict: PASS（初回レビュー + fix 差分の再レビュー。text-only fix の確認も PASS）
- reviewer: reviewer（この変更を書いていない別エージェント）
- HEAD: base 6200365 / レビュー時 041efc8（レビュー中に f7e98a6 まで前進。進んだ commit は範囲外）。未 commit の作業ツリーをレビュー。先に未 commit だった docs/design* などは範囲外
- 受入: 8/8。`npm run check` exit 0（oxlint 0 / oxfmt OK / tsrs 5 workspace / 187 tests / build / knip）。web は typecheck / build / test（12 tests）。
- blocking: なし。低 4 件のうち 3 件を修正（vite conditions に既定3条件を併記 / D043 の pin 表現 / Log・touches）。残り 1 件は下記。
- 残件: `createWebClient` の options を、route が params / request を持つとき必須にする（現状は型で落ちず実行時に Error）。0102 で扱う。
- 未確認: クリーン環境での `npm install`、実ブラウザ表示（0043）、引用記事の本文（403。Vite 8 が Rolldown なのは build で確認）。
