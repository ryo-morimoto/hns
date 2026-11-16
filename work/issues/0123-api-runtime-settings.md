# 0123: Runtime settings API（limits / default model / retention）

status: open
priority: next
design: pending
depends-on: 0027, 0162, 0145, 0146
touches: packages/core/src/graphql/, packages/core/test/graphql/, packages/store/src, packages/store/test, packages/server/src, packages/server/test

## Goal

環境変数で固定している制限・既定モデル・保持期間を、実行中に読み書きできるようにする。
変更は監査し、検証に失敗したら適用しない。

## Acceptance criteria

- [ ] GET /api/settings と PATCH /api/settings
- [ ] turns/min、日次トークン、turn timeout、既定 provider/model、event 保持日数
- [ ] 0 は無制限として明示。負数・未知の model・過大な値は 400
- [ ] 変更は即時反映し、再起動が必要な項目は requiredRestart を返す
- [ ] 監査イベントに変更前後を残す（秘密は含めない）
- [ ] テスト: 境界、0、未知 model、部分更新、監査

## Notes

- 0107 の Settings が使う
- provider の鍵はここに入れない（0069 / 0122）
- env の値を初期値にし、保存値が勝つ。保存値が壊れていたら起動時に失敗する

## やらないこと

- マルチユーザーごとの設定
- バックアップ設定（0124）
