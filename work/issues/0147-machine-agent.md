# 0147: マシンエージェント（cloudflared・署名・sandbox）

status: open
priority: plan
depends-on: 0145
touches: packages/machine/

## Goal

マシン側で動く常駐エージェントを作る。外向き接続だけで Cloudflare から届き、
署名を検証し、sandbox の外に出ない。0052 の hide 配線をここで受入条件に含める。

## Acceptance criteria

- [ ] `cloudflared` の後ろで `127.0.0.1` に待ち受ける（inbound ポートを開けない）
- [ ] リクエスト署名（Ed25519。鍵は DO の secret、公開鍵は登録時に保存）と時刻窓・nonce で再生を拒否
- [ ] パスは ROOT 内に正規化し、symlink の親で外に出ない。失敗は型付きの拒否
- [ ] `exec` は bwrap 経由。sandbox が無ければ exec を出さない（fail closed）
- [ ] `~/.config/hns` と `.git` の書き込みを拒否（0052 の hide を起動時に配線）
- [ ] 同時実行数・出力サイズ・時間の上限
- [ ] 二重接続のうち古い方を seq で弾く
- [ ] 署名検証と ROOT 脱出のテスト（実 HTTP、モックなし）

## Notes

- PoC: `work/poc/cf-harness/agent/server.mjs`（HMAC・ROOT 封じ込め・上限）。sandbox は無い。
- HMAC は共有秘密なので製品では Ed25519 にする。PoC の結論は「署名検証は 1 か所に集まる」。
- エージェントは配布物になる（nix / 単体バイナリ / npm）。配布は 0040 に含める。

## やらないこと

- 認証・machine の登録（0148）。
- Windows / macOS の sandbox（0006 の範囲外）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
