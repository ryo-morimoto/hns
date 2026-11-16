# 0112: Automation 画面（trigger / action / firings）

status: open
priority: plan
design: pending
depends-on: 0038, 0102, 0131
touches: packages/web/src/screens/automations, packages/web/test/automations

## Goal

Schedule / Webhook の Automation を作成・編集し、有効/無効と firings を確認する。

## Acceptance criteria

- [ ] 一覧（project で filter）、作成、名前・enabled の変更
- [ ] trigger: schedule（cron / timezone）と webhook。webhook の URL を表示・コピー
- [ ] action: workflow / chat / task。必要な入力を出し分ける
- [ ] firings の status / at / detail / run_id。失敗理由が見える
- [ ] cron の検証（server と同じ規則）と、次回実行の表示
- [ ] 空 / loading / error / 無効 / 失敗 の状態
- [ ] テスト: create/update、trigger 分岐、validation、firings

## Notes

- cron の正本は server。UI は server の検証結果を表示し、独自実装を増やさない
- webhook token は URL に含むが、ログに出さない
- 0110 の run と重複する表示は、firing から run を開くだけにする

## やらないこと

- Schedule の実行基盤（0038）
- 通知の配信（0126）
