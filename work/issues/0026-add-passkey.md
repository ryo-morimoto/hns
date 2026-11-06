# 0026: 2台目のパスキーを追加する

status: open
depends-on: 0025
touches: work/poc/app

## Goal

ログイン中に別の認証器を登録し、同じ DEK をその PRF でも開けるようにする。

## Acceptance criteria

- [ ] ログイン中に `/api/passkey/add/options` で新しい credential を作る
- [ ] 新しい PRF で DEK を包み、`user_keys` に追加
- [ ] 追加後、その認証器だけでログインできる
- [ ] 既存の包みを消さない

## Log

- 2026-11-06: テーブルは複数の包みを持てる。追加の導線だけ未実装。
