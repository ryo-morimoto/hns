# 0025: 複数の包みと復旧コード（要件14）

status: done
depends-on: 0023
touches: work/poc/app

## Goal

1つの DEK を複数の鍵で包む。パスキーを失っても復旧コードで開ける。

## Acceptance criteria

- [x] 包みを複数持てる（`user_keys` テーブル）
- [x] 登録時にパスキー（PRF）と復旧コード（PBKDF2）の2つで包む
- [x] 復旧コードを見せ、コードだけでログイン＋復号できる
- [x] 誤ったコードは 401
- [x] PRF 非対応でも復旧コードで開ける

## Result

- `recovery.mjs`（コード生成・PBKDF2・AES-GCM の open）、`/api/passkey/recovery`。
- コードは `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`（25文字、約125bit）。
- テスト `run-prf.mjs` 9/9。残り: 2台目のパスキーを後から追加する導線（0026）。
