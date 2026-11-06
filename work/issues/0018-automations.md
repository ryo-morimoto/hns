# 0018: Automations（Schedule / Webhook）

status: done
depends-on: 0017
touches: work/poc/app, docs/automation.md

## Goal

要件12。時刻または Webhook で Workflow を起動し、実行の記録を残す。

## Acceptance criteria

- [x] Automation（trigger / action / enabled）を保存できる
- [x] Webhook で Workflow Run が始まる
- [x] スケジュールで同じことができる
- [x] Firing に成否と Run が残る
- [x] 同時実行は 1 つに制限される

## Log

- 2026-11-06: 要件に追加。設計は [automation.md](../../docs/automation.md)。
- 2026-11-06: 実装。17/17 合格。

## Result

- `cron.mjs`（5 フィールド、ローカル時刻）。`automations` / `firings` を Control Plane に追加。
- Webhook: `POST /api/hooks/<token>` → 202、非同期に Workflow Run を開始。無効なら 409。
- Schedule: 30 秒ごとの tick。同じ分は一度だけ。
- 同時実行は Automation ごとに 1 つ。重なった分は `skipped` の Firing。
- action は workflow / chat / task。
- テスト用の `POST /api/debug/tick`。