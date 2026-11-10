# 0158: 認証の再編（passkey / PRF / デバイス鍵）

status: open
priority: plan
depends-on: 0022, 0023, 0025, 0026, 0145
touches: packages/server/src/auth/, packages/core/src/auth.ts

## Goal

passkey と PRF を Worker の上で成立させ、マシンの認証をデバイス鍵に寄せる。
tailnet の入口認証（D016）は廃止し、外部 IdP は使わない。

## Acceptance criteria

- [ ] WebAuthn の検証を Worker で行う（RP ID は配備先のドメイン、ES256）
- [ ] PRF の unwrap はブラウザのみ。DO は包んだ DEK しか触れない
- [ ] セッション cookie の属性（Secure / HttpOnly / SameSite / 期限）を固定
- [ ] マシンはデバイス鍵で認証（0147）。tailnet 由来の認証を削除
- [ ] Cloudflare Access を使わない理由を文書に残す
- [ ] ログインできないときの復旧（復旧コード）を通す

## Notes

- PoC は認証無し。0145 の境界に後から入れる。
- 単一ユーザー前提。RBAC は作らない（U-12）。

## やらないこと

- チーム利用。
- ソーシャルログイン。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
