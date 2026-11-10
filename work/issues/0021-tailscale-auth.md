# 0021: tailnet の ID で認証する（要件13）

> 0158（認証の再編）でデバイス鍵に置き換え（D047）。入口の認証として再利用しない。

status: superseded
depends-on: 0019
touches: work/poc/app, docs/auth.md

## Goal

共有 token をやめ、tailnet の利用者を境界にする。

## Acceptance criteria

- [x] 接続元 IP を `tailscale whois` で引いて利用者を決める
- [x] 許可リスト（LoginName）で絞る
- [x] whois が失敗したら拒否。ループバックは既定で拒否
- [x] `auth: "tailscale"` でアプリ全体を切り替えられる

## Result

`tailscale.mjs` と `startApp({ auth: "tailscale" })`。テストは 10/10。
`tailscale serve` のヘッダは信じない（詐称可能）。
詳細は [auth.md](../../docs/auth.md)。
