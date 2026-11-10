# 0031: 製品の土台（core・ゲート）

status: in-progress
priority: now
depends-on: 0014
touches: packages/protocol, apps, docs/engineering.md

## Goal

PoC を製品コードへ移す土台を作る。型を先に書き、実サーバで検証する。

## Acceptance criteria

- [x] `packages/core` にモデル（types.ts）
- [x] oxlint + oxfmt + vendored anti-slop。knip / boundaries は未
- [ ] CI（`npm run check` は用意。CI 未接続）

## Log

- 2026-11-07: 方針を [engineering.md](../../docs/engineering.md) に固定（D026〜D028）。
- 2026-11-07: `packages/protocol` を作成（後に `core` に改名）。
- 2026-11-07: anti-slop を vendored し、oxlint / oxfmt / 型検査を `scripts/check.sh` にまとめた。
- 2026-11-07: ゲートを `package.json` の `check` に移し、`scripts/check.sh` を削除した（メンテ対象を減らすため）。
- 2026-11-07: pi の packages 構成に合わせ、`packages/core`（npm workspaces、`exports` の source 条件、`tsconfig.build.json`、README/CHANGELOG）に作り直した。