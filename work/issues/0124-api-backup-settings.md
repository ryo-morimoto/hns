# 0124: Backup の状態・実行・スケジュール API

status: open
priority: plan
design: pending
depends-on: 0145, 0146, 0164
touches: packages/core/src/http.ts, packages/core/src/http-schemas.ts, packages/core/test, packages/store/src, packages/store/test, packages/server/src, packages/server/test

## Goal

バックアップの最終状態、手動実行、スケジュール、復元を API から扱う。
0020 の取得・復元を、UI とスケジューラから使える形にする。

## Acceptance criteria

- [ ] GET /api/backup が last_run / size / destination / schedule / status を返す
- [ ] POST /api/backup/run で手動実行。進行中は 409
- [ ] PATCH /api/backup/schedule で cron / enabled。不正 cron は 400
- [ ] POST /api/backup/restore は確認トークン付き。パスは保存済み destination のみ
- [ ] 失敗・中断・容量不足を status と detail で返す。秘密やファイル本文は返さない
- [ ] テスト: 実行、二重実行、スケジュール、復元の拒否、パス境界

## Notes

- 0107 の Settings が使う
- 復元は破壊的。UI 側で二段確認し、API も確認トークンを要求する
- 0020 の形式を変えるなら、既存バックアップの互換を issue 内で決める

## やらないこと

- クラウドへの転送
- 定期実行の実装（0038 のスケジューラに載せる）
