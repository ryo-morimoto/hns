# 0168: checkpoint と R2 の保持（GC・保持期間）

status: open
priority: next
design: agreed
design-ref: docs/durability.md §5
depends-on: 0154, 0155
touches: packages/workspace/src/retention.ts, packages/workspace/test/retention.test.ts

## Goal

checkpoint は Run ごとに増える。放っておくと R2 と `refs/hns` が単調増加する。
何を残し、何を捨て、捨てたあと restore がどこまで戻れるようにするかを決める。

## Acceptance criteria

- [ ] 保持規則: 直近 N 個 + 日次1個 + 月次1個、のような形を決める
- [ ] reachability で判定する（`refs/hns` から辿れる object を残す）。時間で消さない
- [ ] 消したあと restore できること（消した checkpoint は選べない、が現在は戻せる）
- [ ] 共有 object を消さない（複数の ref から参照されるもの）
- [ ] 削除の前に R2 の object lock / versioning と矛盾しないか確認
- [ ] 保持の上限をテストで固定（1 workspace あたりの object 数）

## Notes

- 0153 の dedupe と 0156 の切り詰めが前提。J は checkpoint で捨てるが、checkpoint 自体は残る。
- 監査のため audit / イベントは checkpoint と別に保持する（0058）。

## やらないこと

- バックアップの世代管理（0164）。

## Log

- 2026-11-07: 作成（[D048](../../docs/decisions/D048.md) と [durability.md](../../docs/durability.md) を契約として）。
