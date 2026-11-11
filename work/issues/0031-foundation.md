# 0031: 製品の土台（core・ゲート）

status: done
priority: now
depends-on: 0014
touches: packages/core, tools/gate, tools/oxlint, package.json, docs/engineering.md

## Goal

PoC を製品コードへ移す土台を作る。型を先に書き、実サーバで検証する。

## Acceptance criteria

- [x] `packages/core` にモデル（types.ts）
- [x] oxlint + oxfmt + vendored anti-slop（knip / boundaries は 0042 で完了）
- [x] `npm run check` を用意（CI への接続は 0041 が所有）

## やらないこと

- CI への接続と Node の固定（0041）
- 0032 以降のパッケージ移植

## Log

- 2026-11-07: 方針を [engineering.md](../../docs/engineering.md) に固定（D026〜D028）。
- 2026-11-07: `packages/protocol` を作成（後に `core` に改名）。
- 2026-11-07: anti-slop を vendored し、oxlint / oxfmt / 型検査を `scripts/check.sh` にまとめた。
- 2026-11-07: ゲートを `package.json` の `check` に移し、`scripts/check.sh` を削除した（メンテ対象を減らすため）。
- 2026-11-07: pi の packages 構成に合わせ、`packages/core`（npm workspaces、`exports` の source 条件、`tsconfig.build.json`、README/CHANGELOG）に作り直した。
- 2026-11-11: 受入条件を現状に照合して done。モデル・anti-slop・ゲートは完了し、knip / boundaries は 0042 が done。残りの CI 接続は 0041 の受入条件と重複するため 0041 に委ねた。

## Result

- review: 対象外（追跡 Markdown のみ。`docs/review/process.md` の対象パス—`packages/*/src`・`test`・規範 docs・依存—を変更しない）
- HEAD: 438fbb8 + 本コミット
- 確認: `packages/core/src/types.ts`、`tools/oxlint/anti-slop/`、`tools/gate/` が現存。`npm run check` は全 stage 通過（201 tests、build、deploy --dry-run、knip）。
- 残件: CI 接続と Node 固定は 0041（batch）。
