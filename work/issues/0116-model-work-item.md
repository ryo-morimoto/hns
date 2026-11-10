# 0116: WorkItem モデル（task / run / conversation を束ねる）

status: open
priority: plan
depends-on: 0047, 0049, 0145, 0146
touches: packages/core/src/types.ts, packages/core/src/schemas.ts, packages/core/src/http.ts, packages/store/src, packages/store/test, packages/server/src, packages/server/test

## Goal

task / workflow run / conversation を、人間が追う1つの「仕事」として束ねる。
所有者は人間、実行者は Agent。UI のカードと Ack / 通知 / 証拠の共通の宛先にする。

## Acceptance criteria

- [ ] core に WorkItem（id / project_id / kind / title / status / owner / refs / created_at / updated_at / revision）を定義
- [ ] refs は task_id / run_id / conversation_id を持てる。1つ以上は必須。同じ会話を二重に別 WorkItem にしない
- [ ] store に work_items と link の migration。外部キーと一意制約
- [ ] 既存の task / run / conversation から WorkItem を導出する移行（既存データを壊さない）
- [ ] server の overview / conversation / run が work_item_id を返す
- [ ] status は表示用の射影。二重の正本を作らない（元の status を保持）
- [ ] テスト: link の一意性、移行、project 分離、削除/アーカイブの扱い

## Notes

- WorkItemId はブランドする。task / run / conversation の id と混ぜない
- 1 WorkItem が複数 conversation を持つのは、run の一部としてなら許す。UI は代表会話を選ぶ
- owner はまず「人間1人」。チーム / RBAC は Non-goal
- 0115 の kind + id を置き換えるのではなく、work_item_id を追加して移行する

## やらないこと

- Ack（0117）
- 通知（0126）
- マルチユーザーの所有権
