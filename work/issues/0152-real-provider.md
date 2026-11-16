# 0152: 実プロバイダ（faux → 実・ストリーミング・usage）

status: open
priority: plan
design: pending
depends-on: 0146, 0151
touches: packages/agent/src/provider/

## Goal

faux の台本を実プロバイダに置き換え、DO からのストリーミングと usage の記録を通す。

## Acceptance criteria

- [ ] Ollama Cloud と OpenCode Go の 2 つで会話が通る（0012 / 0013 の再確認）
- [ ] token の delta がブラウザまで WS で流れる（0159）
- [ ] usage をターン単位で記録し、gateway の上限と突き合わせる
- [ ] 失敗（429 / 5xx / 中断）の扱いを決めてテスト
- [ ] 長い応答で DO の CPU / メモリが上限に当たらないことを測る（0163）

## Notes

- PoC は faux。実測の RTT はプロバイダの時間を含まない。
- ストリーミングのスループットは未計測（RESULTS.md の未計測項目）。

## やらないこと

- Google 系（権限待ち）。
- モデルの自動選択。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
