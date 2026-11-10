# 0039: 観測の製品化

status: open
priority: plan
depends-on: 0145, 0146
touches: packages/store, packages/server

## Goal

イベントログとメトリクスを製品の API と UI で使えるようにする。

## Acceptance criteria

- [ ] events を store に保存し /api/events・/api/metrics を提供
- [ ] リクエスト ID と HTTP・会話・ツール・Workflow の記録
- [ ] body・header・token を記録しない
- [ ] 保持期間を設定できる
