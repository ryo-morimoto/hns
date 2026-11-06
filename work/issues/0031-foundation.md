# 0031: 製品の土台（protocol・契約テスト・ゲート）

status: in-progress
depends-on: 0014
touches: packages/protocol, apps, docs/engineering.md

## Goal

PoC を製品コードへ移す土台を作る。契約を先に書き、実サーバで検証する。

## Acceptance criteria

- [x] `packages/core` にドメイン型（types.ts）と zod 契約
- [x] 契約テスト: 実サーバのレスポンスをスキーマで検証
- [x] OpenAPI 生成（3.1）。型付きクライアントは未
- [x] oxlint + oxfmt + vendored anti-slop。knip / boundaries は未
- [ ] CI（`scripts/check.sh` は用意。CI 未接続）

## Log

- 2026-11-07: 方針を [engineering.md](../../docs/engineering.md) に固定（D026〜D028）。
- 2026-11-07: `packages/protocol` を作成。契約テスト 6/6、型検査も通る。
- 2026-11-07: anti-slop を vendored し、oxlint / oxfmt / 契約テストを `scripts/check.sh` にまとめた。
- 2026-11-07: pi の packages 構成に合わせ、`packages/core`（npm workspaces、`exports` の source 条件、`tsconfig.build.json`、README/CHANGELOG）に作り直した。