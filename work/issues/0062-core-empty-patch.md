# 0062: 空の PATCH をどう扱うか決める

status: open
priority: batch
depends-on: 0037
touches: packages/core

## Goal

`AutomationUpdateSchema` は `{}` を受け付ける（`TaskUpdate` / `ConversationUpdate` も同様）。空の更新は
成功として返すのか、`invalid_request` にするのかを決め、契約に反映する。

## Acceptance criteria

- [ ] 「1 フィールド以上」を要求するか、空を許容するかを決めて schema に反映する
- [ ] 対象の PATCH スキーマを列挙し、同じ規則にする（`Task` / `Conversation` / `Automation` / `Workflow`）
- [ ] 決めた挙動のテスト（空を受ける / 拒否する）

## Notes

- 空 PATCH を許すと「何も変えない 200」が返る。クライアントの楽観更新と相性が悪い。
- `WorkflowUpdate` は 0053 以降 `version` 必須なので対象外。

## Log

- 2026-11-07: 作成（コードレビューで空 PATCH が通るのを見つけた）。
