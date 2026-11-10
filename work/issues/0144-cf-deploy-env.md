# 0144: 配備と環境（cf CLI・cloudflare.config.ts・秘密の投入）

status: open
priority: now
depends-on: 0140
touches: deploy/, package.json, docs/engineering.md

## Goal

製品の Worker を `cf` で配備できるようにし、dev / stg / prod の分け方と秘密の入れ方を固定する。

## Acceptance criteria

- [ ] `cloudflare.config.ts` をリポジトリで持ち、`wrangler.toml` を持たない
- [ ] Durable Object は `exports.durableObject({ storage: "sqlite" })` で宣言
- [ ] 環境ごとの Worker 名・var・secret の対応表（dev はローカル、stg / prod は別 Worker）
- [ ] 秘密は `cf deploy --secrets-file` か Secrets Store のどちらか一方に統一し、リポジトリに置かない
- [ ] ロールバック手順（version を戻す）と、DO の SQLite が戻らないことを明記
- [ ] `cf deploy --dry-run` をチェックに入れる

## Notes

- PoC で通した形: `cf migrate wrangler.toml` → `cloudflare.config.ts` → `cf deploy`。DO は Created: Session。
- `HNS_AGENT_URL` のようにビルド時の env を config が読む形にすると、配備先を切り替えられる。
- バンドルは 897KB / gzip 204KB、startup 6ms。

## やらないこと

- CI（0041）。
- 独自ドメインとゾーン（0160）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
