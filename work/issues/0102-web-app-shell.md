# 0102: App shell と hash router

status: in-progress
depends-on: 0101
touches: packages/web/src/app, packages/web/src/routes, packages/web/src/api/fixtures.ts, packages/web/src/components/Icon.tsx, packages/web/src/components/Menu.tsx, packages/web/src/main.tsx, packages/web/index.html, packages/web/test/app

## Goal

全画面が載る外枠を作る。左サイドバー、上バー、status、テーマ、プロジェクト切替、
hash URL（ワークスペース / 会話）と戻る/進むを提供する。

## Acceptance criteria

- [ ] #/p/:projectId と #/p/:projectId/c/:conversationId を解釈し、未知の hash はワークスペースへ正規化
- [ ] ブラウザの戻る/進むで画面が戻る。プロジェクトは URL が真
- [ ] サイドバー: ワークスペース、会話一覧、タスク、実行。モバイルは scrim + 外側タップで閉じる
- [ ] 上バー: プロジェクト切替、現在地、接続、テーマ、コマンドの入口
- [ ] テーマ system / light / dark。localStorage に保存し、OS 変更に追従
- [ ] 390px で横 overflow が無い。エディタ用の右パネル領域を予約できる
- [ ] モバイル（〜768px）のフッターは composer を主とし、汎用の下部ナビバーを作らない（2026-11-07 ユーザー判断。0105 の composer で設計する）
- [ ] route / theme / mobile のテスト

## Notes

- agentic system ではコンテキストスイッチとタスクスイッチが高頻度（interface.md 原則14）。ただし下部バーは作らない: フッターは composer が主で、頻繁操作は composer と共存できる形ができるまで上部・drawer・キーボードに置く（低優先度）
- モバイルの切替は上部のメニュー → drawer（プロジェクト / 会話 / タスク / 実行）
- router は小さな hash router でよい。React Router を足すのは、画面が増えて必要になったとき
- 画面は lazy ではなく、最初は直接 import。分割は必要になってから
- TanStack Query の Provider はここではなく main.tsx。shell は data を持たない

## やらないこと

- Workspace / Conversation の中身（0104 / 0105）
- CommandPalette の実装（0103）

## Log

- 2026-11-07: hash router（#/p/:id、#/p/:id/c/:id、未知 hash の正規化）、shell（top bar / sidebar / 右パネル枠）、モバイル drawer（Base UI Drawer、swipeDirection=left）、theme（system/light/dark + localStorage）を実装。fixtures に conversations / runs を追加し、shell の 9 テストを追加（web 計 40）。コマンドの入口は 0103 まで disabled。
- 2026-11-07: ユーザーレビューでモバイルの下部バーは不要（フッターは composer が主）と判断され、削除。切替は上部メニュー → drawer に残した。composer と頻繁操作の共存 UI は低優先度の将来課題。
- 2026-11-07: drawer は開いている間だけ mount する（閉じた状態が白い overlay を描いていた）。

## Result

- verdict: PASS（独立レビュー3回: 初回 PASS（低5）→ 修正 → PASS（低3）→ 修正 → PASS）
- reviewer: reviewer-0102（この変更を書いていない別エージェント）
- HEAD: base ceba0cf。レビューは未 commit の作業ツリーで行い、commit はこの Result の後
- 受入: 7/7。下部バーはユーザー判断で削除し、受入を「フッターは composer が主」に差し替えた
- blocking: なし。低 8 件を修正（body margin / drawer backdrop の二重 alpha / 長いプロジェクト名の trigger と popup / fixture の project 絞り込み / 古いコメント / theme の menuitemradio 化 / check の桁ずれ）
- ユーザーレビュー: 下部バー不要の判断を反映済み。改訂版の目視 OK 待ち（done はその後）
- 残件: モバイルの command / Needs you 入口は 0103 / 0113。composer と頻繁操作の共存 UI は低優先度。200% zoom・offline・実機タッチは未確認
