# 0130: Workflow の archive / delete

status: open
priority: next
design: pending
depends-on: 0038, 0145, 0146
touches: packages/core/src/http.ts, packages/core/src/http-schemas.ts, packages/core/test, packages/store/src, packages/store/test, packages/server/src, packages/server/test

## Goal

Workflow を一覧から隠す。run の履歴は残し、実行中の run は勝手に止めない。
削除は監査付きの archive を基本にし、物理削除はしない。

## Acceptance criteria

- [ ] POST /api/workflows/:id/archive と /unarchive
- [ ] archive 済みは一覧から除外（includeArchived で取得可）。新規 run の開始は 409
- [ ] 既存 run / 会話 / firing は残る。archive で run を止めない
- [ ] 二重 archive は idempotent。不明は 404
- [ ] 監査イベント。UI 0111 に archive / unarchive を出す
- [ ] テスト: archive、run 開始拒否、履歴、unarchive、二重

## Notes

- 0038 の run は workflow の版を保持している。archive 後も参照できる
- 物理削除は要件に無い。DB の外部キーを壊さない
- 0111 の graph editor は archive 済みを編集できない（unarchive を先に）

## やらないこと

- 物理削除 / 完全消去
- 別 project への移動
