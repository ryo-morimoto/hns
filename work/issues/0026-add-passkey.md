# 0026: 2台目のパスキーを追加する

status: done
depends-on: 0025
touches: work/poc/app

## Goal

ログイン中に別の認証器を登録し、同じ DEK をその PRF でも開けるようにする。

## Acceptance criteria

- [x] ログイン中に `/api/passkey/add/options` で新しい credential を作る
- [x] 新しい PRF で DEK を包み、`user_keys` に追加
- [x] 追加後、その認証器だけでログインできる
- [x] 既存の包みを消さない

## Log

- 2026-11-06: テーブルは複数の包みを持てる。追加の導線だけ未実装。
- 2026-11-06: 実装。4/4 合格。

## Result

- `/api/passkey/dek`（unlocked のセッションだけ）、`/api/passkey/add/options`、`/api/passkey/add/verify`。
- ブラウザが DEK を取り出し、新しい認証器の PRF で包み直す。既存の包みは残す。
- テスト: 1台目の credential を消してから追加し、**2台目だけでログイン**して同じ秘密が読める。
- 注意: `/api/passkey/dek` は unlocked 中だけ DEK を返す。XSS はこの境界を破れる（TLS と CSP 前提）。