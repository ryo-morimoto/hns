# 0038: Workflow / Automation の実行基盤

> 前提変更: 実行基盤は Session DO（0146）。alarm と wake の上で動かす。

status: open
priority: plan
design: pending
depends-on: 0145, 0146
touches: packages/server, packages/core

## Goal

Workflow / Automation を製品品質の実行基盤にする。

## Acceptance criteria

- [ ] 状態遷移は core/workflow.ts の表だけを通す
- [ ] 並列・分岐・再試行・人間待ち・中断からの再開
- [ ] schedule / webhook、同時 1 実行、スキップ、再試行
- [ ] 同じ firing / run を二重に実行しない
