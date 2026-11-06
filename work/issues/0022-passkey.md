# 0022: passkey と暗号化（要件13・未実装）

status: open
depends-on: 0021
touches: work/poc/app, docs/auth.md

## Goal

WebAuthn でログインし、PRF から導いた鍵で秘密を暗号化する。

## Acceptance criteria

- [ ] 登録・ログイン（`@simplewebauthn/server`、credential を Control Plane に保存）
- [ ] 端末ごとに失効できるセッション
- [ ] PRF から導いた鍵でデータ鍵を包み、ログイン中だけ復号
- [ ] Automation 用の資格情報をユーザーの秘密と分ける

## Log

- 2026-11-06: 設計は [auth.md](../../docs/auth.md)。ブラウザ認証器が必要で自動テストが組めないため保留。
