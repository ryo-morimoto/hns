# 0165: 安全の再評価（XSS→exec・サプライチェーン・egress）

status: open
priority: plan
depends-on: 0147
touches: docs/safety.md, packages/machine/test/security/

## Goal

Cloudflare から手元の exec に届く構成になったぶん、攻撃面を洗い直す。

## Acceptance criteria

- [ ] UI の XSS が exec に届く経路を塞ぐ（CSP、エスケープ、権限の分離）
- [ ] Worker の依存を最小にし、デプロイ権限を exec 権限として扱う
- [ ] DO から出る通信先を絞る（provider gateway とトンネルのみ）
- [ ] sandbox の fail closed を再確認（bwrap 無しは exec を出さない）
- [ ] エージェントの攻撃面（署名・nonce・パス・出力上限）のレビュー
- [ ] 事故時の封じ込め（鍵失効・machine 失効・Worker 停止）

## Notes

- 0052（hide 未配線）が閉じていないと、手元の鍵はエージェントから読める。

## やらないこと

- マルチテナントの分離。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
