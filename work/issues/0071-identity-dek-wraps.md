# 0071: 復旧コードと2台目のパスキー（DEK の包み）

status: open
priority: plan
depends-on: 0069, 0070
touches: packages/store/src/identity/wraps.ts, packages/store/test

## Goal

DEK を PRF と復旧コードで包み、unlocked の間だけ開けるようにする。2台目の認証器は PRF で包み直して追加する。

## Acceptance criteria

- [ ] 復旧コードの生成・正規化（大文字・区切り除去・紛らわしい文字を除く）と PBKDF2-SHA256 600,000 回での鍵導出
- [ ] DEK の wrap / unwrap。包みは複数持て、1つ消しても他で開ける
- [ ] 誤ったコード・誤った鍵は復号失敗。理由（コード違い / 鍵違い）を区別する
- [ ] unlock はメモリにだけ DEK を置き、DB には包みだけを残す
- [ ] 2台目の追加: unlocked のときだけ DEK を返し、新しい包みを足す。既存の包みは残す
- [ ] テスト: 包みの追加後に古い包みで開ける、ロック中は user の秘密を読めない

## Notes

- PRF の salt は登録時に決めて user_keys に残す（0048 の列）
- WebAuthn の検証は 0070 の関数を呼ぶ。ここで challenge を作り直さない
- 平文の DEK はリクエストをまたいで保存しない

## やらないこと

- セッション cookie（0035）
- 復旧コードの画面（0036）
