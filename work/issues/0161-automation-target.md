# 0161: automations の実行先（マシン必須の明示）

status: open
priority: next
design: pending
depends-on: 0038, 0148
touches: packages/core/src/workflow.ts, packages/server/src/automations/

## Goal

automations の起動を **Cron Triggers** にし、マシンが寝ているときの挙動を決める。実行基盤に Cloudflare Workflows を採るかもここで決める。

## Acceptance criteria

- [ ] 起動は Cron Triggers（最短 1 分）。DO の alarm は実行中 run の wake にだけ使う
- [ ] 発火しても実行先が寝ていれば park し、起きたら続きを実行する
- [ ] 多段の Workflow 実行に Cloudflare Workflows を使うかを評価する（自前の逐次実行と比べる）
- [ ] 通知（見逃し・失敗）を決める
- [ ] 実行先に Cloudflare の計算を置かない（今の決定）。将来 Container を足す余地だけ残す
- [ ] 発火の重複（at-least-once）を冪等にする
- [ ] 保留中の Run が溜まったときの上限

## Notes

- Cloudflare に計算を置かない以上、automations はマシンが起きている必要がある。
- ここを埋めるには Containers が要る（PoC では未検証。導入するなら別 issue）。

## やらないこと

- Cloudflare Containers の導入。
- cron の表現力の拡張。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
