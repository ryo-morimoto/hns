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
- [ ] リクエスト署名（Ed25519。秘密鍵はマシン（0600）、公開鍵は D1 の Machine レコード（D049））と時刻窓・nonce で再生を拒否
- [ ] パスは ROOT 内に正規化し、symlink の親で外に出ない。失敗は型付きの拒否
- [ ] `exec` は bwrap 経由。sandbox が無ければ exec を出さない（fail closed）
- [ ] `~/.config/hns` と `.git` の書き込みを拒否し、`~/.config/hns` は読み取りも hide で隠す（0052 を起動時に配線）
- [ ] hide した `~/.config/hns` からデバイス鍵・cloudflared token が読めないことを実機で確認（bwrap 無しは SKIP）
- [ ] machine の env / process に provider 鍵・provider URL が無いことをテストする（harness 側は 0151）
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
- 2026-11-11: 0143 の review を受けて、デバイス鍵を「秘密鍵はマシン / 公開鍵は D1」に直し、hide の読み取りと
  「隠した場所から鍵が読めない」実機テストを AC に追加した。
- 2026-11-11: 再レビューを受けて、machine の env / process に provider 鍵・provider URL が無いことのテストを AC に追加した。
