# 0108: Login / passkey / recovery 画面

status: open
priority: next
design: pending
depends-on: 0070, 0071, 0102
touches: packages/web/src/screens/auth, packages/web/src/api/passkey.ts, packages/web/test/auth

## Goal

passkey の登録・ログイン・復旧コード・2台目の追加を、ブラウザで完結させる。
PRF が無い認証器でも、ロック状態を明示してログインできる。

## Acceptance criteria

- [ ] register / sign in / recovery / add passkey の4フロー
- [ ] WebAuthn options の base64url 変換、challenge、user.id、excludeCredentials
- [ ] PRF がある場合だけ DEK を包む。無い場合は「秘密はロック」と明示
- [ ] 復旧コードは表示一度きり。コピーと「書き留めた」確認
- [ ] 423 / 429 / 401 / ネットワーク失敗を区別して表示

- [ ] テスト: 状態遷移、PRF 無し、復旧、ロック、エラー

## Notes

- WebAuthn の実ブラウザ検証は 0043。ここでは component / unit と仮想 authenticator の境目を明記
- 秘密の DEK はメモリだけ。sessionStorage / localStorage に置かない
- ログイン後の遷移先は元の URL（token は URL に残さない）

## やらないこと

- tailscale のサーバ側検証（0021 / 0035）。D079 で tailnet は廃止
- 複数ユーザー / RBAC
