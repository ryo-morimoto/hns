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
- [ ] モバイル（〜768px）は上バーを「戻る/メニュー + 現在地」に絞り（コマンドは 0103）、会話は戻る矢印、プロジェクト切替・テーマ・接続は drawer に置く。本文は全幅。フッターは composer を主とし、汎用の下部ナビバーを作らない（2026-11-07 ユーザー判断。0105 の composer で設計する）
- [ ] サイドバーは全ワークスペースの Needs you / Running / 最終活動を、切り替える前に表示する（0115 の集計。項目は 0104 / 0115）
- [ ] route / theme / mobile のテスト

## Notes

- agentic system ではコンテキストスイッチとタスクスイッチが高頻度（interface.md 原則18）。ただし下部バーは作らない: フッターは composer が主で、頻繁操作は composer と共存できる形ができるまで上部・drawer・キーボードに置く（低優先度）
- 他ワークスペースの状態を切替前に見せる（interface.md 原則19、`work/research/cross-workspace-status-ui.md`）。件数 + 鮮度を先に、横断の項目リストは 0116/0117 の後
- モバイルの切替は上部のメニュー → drawer（プロジェクト / 会話 / タスク / 実行）。上バーは低クローム（戻る/メニュー + 現在地）にし、テーマ・接続は drawer の下部へ（ChatGPT モバイル参照、interface.md 原則18）
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
- 2026-11-07: ユーザーレビュー「切り替えないと他ワークスペースの進捗が見えない」を受け、横断の状態表示を調査（`work/research/cross-workspace-status-ui.md`）。サイドバーの要件に追加し、0115 に counts の横断取得を足した。件数だけ先に実装する
- 2026-11-07: モバイルを低クロームに変更（ChatGPT モバイル参照）。上バーは戻る/メニュー + 現在地だけにし、プロジェクト切替・テーマ・接続は drawer 下部へ。会話は戻る矢印、コマンドは 0103 まで非表示。本文の余白を 12px に詰め、全幅を使う。web 41 / shell 10 テスト。

## Result

- verdict: PASS（独立レビュー: 初回 PASS（低5）→ 修正 → PASS（低3）→ 修正 → モバイル低クローム PASS（back デルタ込み））
- reviewer: reviewer-0102（この変更を書いていない別エージェント）
- HEAD: base ceba0cf。モバイル低クロームの変更はこの Result の後に commit
- 受入: 8/8。下部バー削除、モバイル低クローム（ChatGPT 参照）、会話の戻る矢印を含む
- blocking: なし。低 8 件 + モバイル低クロームの低指摘を修正（body margin / backdrop の二重 alpha / 長い名前 / fixture filter / menuitemradio / popup 幅 / check ずれ / モバイル title の重複 / back / コマンド非表示）
- ユーザーレビュー: 下部バー不要・モバイル低クロームの判断を反映済み。改訂版の目視 OK 待ち（done はその後）
- 残件: 0105 で会話画面の h1 と本文の戻るリンクを外す（上バーと重複）。モバイル command は 0103、Needs you は 0113。200% zoom・offline・実機タッチは未確認
