# 0022: passkey の登録・ログイン（要件13）

status: done
depends-on: 0158
touches: work/poc/app, docs/auth.md

## Goal

WebAuthn でログインし、PRF から導いた鍵で秘密を暗号化する。

## Acceptance criteria

- [x] 登録・ログイン（`@simplewebauthn/server`、credential を Control Plane に保存）
- [x] 端末ごとに失効できるセッション
- [ ] PRF から導いた鍵でデータ鍵を包み、ログイン中だけ復号（0023）
- [x] Automation 用の資格情報をユーザーの秘密と分ける（0024）

## Log

- 2026-11-06: 設計は [auth.md](../../docs/auth.md)。
- 2026-11-06: 実装。Playwright の仮想認証器で 6/6。

## Result

- `passkey.mjs` / `/api/passkey/*` / `ui/login.html`。`auth: "passkey"` で有効。
- テスト: CDP の `WebAuthn.addVirtualAuthenticator`。`run-passkey.mjs`。
- 残り: PRF による暗号化（0023）。