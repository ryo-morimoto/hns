# 0024: 秘密のスコープ分離（要件14）

status: done
depends-on: 0019
touches: work/poc/app

## Goal

ユーザーの秘密と Automation の実行資格情報を分ける。

## Acceptance criteria

- [x] `user` / `service` のスコープ
- [x] 保存は AES-256-GCM、鍵は state の `secrets.key`（0600）
- [x] `getService` は `user` を読めない
- [x] Provider 鍵を `service` からも読める

## Result

`secrets.mjs`、`/api/secrets`（list / put / delete）。テスト 10/10。
DB ファイルに平文が残らないことも確認。
