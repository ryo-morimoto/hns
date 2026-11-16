# 0169: Journal と切り詰め（append・watermark・256KB閾値）

status: open
priority: plan
design: agreed
design-ref: docs/durability.md §5
depends-on: 0141, 0156
touches: packages/server/src/do/journal.ts, packages/store/src/journal/, packages/server/test/do/journal.test.ts

## Goal

Workspace DO の中の Journal を append 専用にし、checkpoint の watermark で切り詰める。
`journal.json` の全体書き換えをやめ、行数を設計で抑える。

## Acceptance criteria

- [ ] イベントは append のみ。seq は DO のトランザクションで採番
- [ ] intent / outcome / audit / event を1つの表に持ち、種類で分ける
- [ ] 本文は 256KB まで行に持ち、それ以上は R2（0153）に置いて hash だけ残す
- [ ] 1 mutation あたりの行数（目安 5）をテストで固定
- [ ] checkpoint の watermark を書き、それ以前の intent / outcome / 本文を切り詰める
- [ ] 切り詰め後も audit とイベントは残る
- [ ] 読み出しは cursor。全件読みをしない
- [ ] 再送・二重適用のテスト（operationId）

## Notes

- [durability.md](../../docs/durability.md) §5。切り詰めを止めると DO が単調に育つ。
- 行課金は設計で 1000 倍変わる。token 単位の commit をしない。

## やらないこと

- checkpoint の commit 作成（0154）。
- 保持と GC（0168）。

## Log

- 2026-11-07: 作成（0156 から分割。D048）。
