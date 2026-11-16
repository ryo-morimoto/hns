# 0069: 秘密の暗号化（スコープと DEK）

status: open
priority: plan
design: pending
depends-on: 0048
touches: packages/store/src/identity/secrets.ts, packages/store/test

## Goal

0048 の secrets テーブルを使い、AES-256-GCM で保存・復号する。service はサーバ鍵、user は unlocked の DEK だけ。

## Acceptance criteria

- [ ] `createSecretCipher({ serviceKey })` が put / get / list / delete を持つ
- [ ] service: 32 バイトの鍵で暗号化・復号。鍵は呼び出し側が渡す（store は fs も env も触らない）
- [ ] user: 32 バイトの DEK を渡した時だけ復号。渡さなければ locked を型で返す（例外にしない）
- [ ] get は scope と name の組で引き、service から user は読めない
- [ ] 改竄（ciphertext / iv / tag の1バイト変更）は復号失敗として拒否する
- [ ] 誤った鍵・誤った DEK は復号失敗。平文の欠片を返さない
- [ ] list は名前と updated_at だけを返し、値は返さない
- [ ] テスト: 平文・鍵・暗号文がエラーメッセージに出ないこと

## Notes

- 鍵ファイル（`secrets.key`、0600、`HNS_SECRETS_KEY` での上書き）は 0035 が作って渡す。store は暗号だけ
- 503/423 への変換は 0035。ここは Result か判別可能な型で返す
- 暗号文の形（ciphertext / iv / tag の列）は 0048 のテーブルに合わせる

## やらないこと

- PRF・復旧コードによる包み（0071）
- Provider 鍵の取得や使用（0035 の設定・agent）
- HTTP / 設定 UI
