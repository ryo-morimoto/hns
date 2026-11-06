# 0031: 製品の土台（core・レスポンス検証・ゲート）

status: in-progress
depends-on: 0014
touches: packages/protocol, apps, docs/engineering.md

## Goal

PoC を製品コードへ移す土台を作る。型を先に書き、実サーバで検証する。

## Acceptance criteria

- [x] `packages/core` にモデル（types.ts）と zod 検証
- [x] レスポンス検証: 実サーバのレスポンスをスキーマで確認
- [x] oxlint + oxfmt + vendored anti-slop。knip / boundaries は未
- [ ] CI（`scripts/check.sh` は用意。CI 未接続）

## Log

- 2026-11-07: 方針を [engineering.md](../../docs/engineering.md) に固定（D026〜D028）。
- 2026-11-07: `packages/protocol` を作成。レスポンス検証 6/6、型検査も通る。
- 2026-11-07: anti-slop を vendored し、oxlint / oxfmt / レスポンス検証を `scripts/check.sh` にまとめた。
- 2026-11-07: pi の packages 構成に合わせ、`packages/core`（npm workspaces、`exports` の source 条件、`tsconfig.build.json`、README/CHANGELOG）に作り直した。