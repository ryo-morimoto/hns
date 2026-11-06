# 0018: Automations（Schedule / Webhook）

status: open
depends-on: 0017
touches: work/poc/app, docs/automation.md

## Goal

要件12。時刻または Webhook で Workflow を起動し、実行の記録を残す。

## Acceptance criteria

- [ ] Automation（trigger / action / enabled）を保存できる
- [ ] Webhook で Workflow Run が始まる
- [ ] スケジュールで同じことができる
- [ ] Firing に成否と Run が残る
- [ ] 同時実行は 1 つに制限される

## Log

- 2026-11-06: 要件に追加。設計は [automation.md](../../docs/automation.md)。
