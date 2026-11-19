# 0117: Attention Ack API（確認済み・Undo）

status: open
priority: next
design: pending
depends-on: 0047, 0116
touches: packages/core/src/types.ts, packages/core/src/graphql/, packages/core/test/graphql/, packages/store/src, packages/store/test, packages/server/src, packages/server/test

## Goal

Needs you を「見た」と記録し、作業完了とは区別してキューから外す。
Ack は WorkItem の revision に紐づき、仕事が更新されたら再表示される。

## Acceptance criteria

- [ ] POST /api/work-items/:id/ack と DELETE /api/work-items/:id/ack（Undo）
- [ ] ack は work_item_id + revision を持つ。revision が変わると無効
- [ ] 二重 ack は idempotent。存在しない / 権限なし / revision 不一致を区別
- [ ] overview は有効な ack の item を needs から外す。completed には移さない
- [ ] 監査イベントを残す（ack / unack）。秘密や本文は入れない
- [ ] テスト: ack、undo、revision 変更で再表示、二重 ack、404

## Notes

- 0115 の needs に ack 状態を足すか、server 側で除外するかは実装で決める。どちらも revision を条件にする
- UI 0104 の「確認済み」はこの API を呼ぶ。localStorage の PoC 実装は持ち込まない
- Ack は「完了」ではない。task の status や run の結果を書き換えない

## やらないこと

- 通知（0126）
- 一括 Ack（必要になったら別 issue）
