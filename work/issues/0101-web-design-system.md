# 0101: Web のデザインシステムとプリミティブ

status: in-progress
depends-on: 0100
touches: packages/web/src/design, packages/web/src/components/Button.tsx, packages/web/src/components/Badge.tsx, packages/web/src/components/Icon.tsx, packages/web/src/components/Dialog.tsx, packages/web/src/components/Menu.tsx, packages/web/src/components/Toast.tsx, packages/web/src/components/Skeleton.tsx, packages/web/test/design, packages/web/package.json, package-lock.json

## Goal

PoC のトークンと操作感を、製品のデザインシステムに落とす。
見た目の部品ではなく、focus / hover / selected / disabled / reduced motion を含む状態の契約にする。

## Acceptance criteria

- [x] light / dark の CSS 変数（背景・面・境界・本文・補助・accent・danger・warn・ok・focus）
- [x] Button（primary / ghost / danger / icon / disabled）、Badge、Icon、Skeleton
- [x] Dialog と Menu は Base UI（`@base-ui/react` 1.9.0）を土台にし、Esc / focus 戻し / outline を満たす。独自 focus trap を書かない
- [x] Toast は role=status / alert と action（Undo）を持つ
- [x] prefers-reduced-motion で motion を止める。focus-visible を全 interactive 要素に
- [x] 各プリミティブの render / keyboard テスト。disabled と loading の見た目が状態で分かる
- [x] 「2箇所以上で使う部品だけ」を作る。使われない variant を足さない

## Notes

- プリミティブの土台は Base UI（`@base-ui/react` 1.9.0、exact pin、D043）。0100 では未使用のため追加していない。Tailwind は入れない（CSS 変数のトークン）
- PoC の app.css をそのまま持ち込まない。トークンと必要な部品だけを抽出する
- 色は light / dark の両方でコントラストを確認する。accent を本文色に使わない
- Icon は SVG path を1箇所にまとめ、サイズは 12 / 14 / 16 に限定する
- Dialog は Base UI の Dialog を使い、独自 focus trap を書かない（Esc / focus 戻し / outline はライブラリと CSS の契約）

## やらないこと

- 画面固有のレイアウト（0102 以降）
- CommandPalette（0103）
- Editor（0106）

## Log

- 2026-11-07: 作成（user）。
- 2026-11-07: 目視・操作レビュー用の gallery（`#/design`、dev のみ）を追加。ユーザーの OK まで done にしない。
- 2026-11-07: Base UI 1.9.0（exact pin）を追加。トークン（light-dark + data-theme、テキストは両テーマで 4.5:1）、Button / Badge / Icon / Skeleton、Dialog / Menu（Base UI 土台）、Toast（role=status / alert + Undo）。design の 17 テストを追加し、npm run check は 204 tests で通る。

## Result

- verdict: PASS（独立レビュー2回: 初回 FAIL（中2件）→ 修正 → 再レビュー PASS）
- reviewer: reviewer-0101（この変更を書いていない別エージェント）
- HEAD: base 23c5e4d / レビュー中に bb0d6ae まで前進（docs のみ）。未 commit の作業ツリーをレビュー
- 受入: 7/7。`npm run check` exit 0（21 files / 204 tests、web 29）。7 は 0102 で実 call site が付く前提（現状はテストのみ）
- blocking: 初回 2 件（--focus の ring が 1.87:1 / danger Badge の 9.5px が 4.31:1）→ 修正済み（ring 6.1:1 / badge 5.8:1）。低 3 件も修正（未使用 --active の削除 / loading の cursor / Dialog の focus 進入 assert）
- 残件: badge を --surface-3 に載せる画面では --danger-text が要る（0104）。Menu の focus 戻しは keyboard 選択テストで実質カバー
- 未確認: 実ブラウザ（focus ring の描画・light-dark・320px の Dialog）、clean `npm ci`、screen reader
- ユーザーレビュー: 待ち。`npm run dev -w @hns/web` の `#/design` で見た目と挙動（light/dark、Dialog の Esc と focus 戻し、Menu のキーボード、Undo、loading）を確認してもらう
