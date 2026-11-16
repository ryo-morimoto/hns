# 0115: Workspace overview API（Running / Needs you / Completed）

> 前提変更: 一覧は D1 の索引から返す（0149）。touches と依存を見直すこと。

> 前提変更: 一覧は D1 の投影から返す（0149）。touches と依存を見直すこと。

status: open
priority: hold
design: pending
depends-on: 0049, 0145, 0146
touches: packages/core/src/graphql, packages/server/src, packages/server/test

## Goal

ワークスペースの1画面分を、1つの endpoint で返す。
web が conversation ごとに /api/state を N 回呼ばずに、Needs you の理由と並び順を決められるようにする。

## Acceptance criteria

- [ ] GET /api/overview?projectId= が counts と needs / running / completed を返す
- [ ] 各 item は kind（task / run / conversation）、id、title、status、reason、updated_at、project_id を持つ
- [ ] reason は閉じた union: waiting_human / run_failed / task_blocked / conversation_blocked / conversation_aborted / conversation_incomplete
- [ ] needs は理由の重要度 → 古い順、running は updated_at 降順、completed は updated_at 降順。上限と as_of を持つ
- [ ] 横断用に、プロジェクトごとの counts（needsYou / running / failed / doneToday / lastActivityAt）を 1 リクエストで返す（projectId 省略時の workspaces 配列、または専用ルート）
- [ ] 1リクエストで完結し、conversation ごとの state 呼び出しを要求しない
- [ ] core の schema / ROUTES と server の parse / response を追加。contract と server のテスト
- [ ] 0116 の WorkItem が入ったら work_item_id を足せる余地を残す（まだ必須にしない）

## Notes

- 0115 は WorkItem が無くても動く。kind + id で識別し、0116 で共通 ID を足す
- 内部語（pi.*）は返さない。reason は UI が文言に写すためのコード
- 「確認済み」は 0117。0115 は ack を除外しない（フィルタは 0117 と一緒に決める）
- 返すのは要約であり、transcript / file 本文は含めない
- サイドバー（0102）は全ワークスペースの counts と鮮度を使う。切替なしで他プロジェクトの Needs you / Running が見えること（interface.md 原則19）。項目レベルの横断リストは 0116 / 0117 の後

## やらないこと

- SSE の配信（0118）
- Ack の永続化（0117）
- 完了の証拠（0120）
