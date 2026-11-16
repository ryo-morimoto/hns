# 0032: 6パッケージへの移植

後継: 0033 / 0034 / 0047 / 0100 / 0145 / 0146（server は 0035 経由）。machine は 0147。

status: superseded
depends-on: 0031
touches: packages/, work/poc/

## Goal

PoC（`work/poc`）を、決めた 6 パッケージに移植する。順序と所有は [packages.md](../../docs/packages.md)。

## Acceptance criteria

- [ ] `@hns/workspace`（workspace-core + sandbox、`./sandbox`）
- [ ] `@hns/store`（db.mjs → リポジトリ、`./identity` に認証と秘密）
- [ ] `@hns/agent`（conversation + ツール + hooks + Model アダプタ）
- [ ] `@hns/server`（HTTP / SSE / Workflow / Automation、bin）
- [ ] `@hns/web`（最後）
- [ ] 各段で型検査が通る

## Log

- 2026-11-07: 構成を決定（D029）。
- 2026-11-07: `@hns/store` を作成。Row 型と公開型への変換（9/9）。
- 2026-11-07: valibot で境界 parse。ErrorCode、Workflow 状態遷移。store 12/12・core 8/8。
- 2026-11-07: store の残りを 0047（SQLite / repositories）と 0048（identity）に分割。server の前提を 0035 に追記。
- 2026-11-17: 0033 / 0034 / 0047 / 0100 / 0145 / 0146（server は 0035 経由）で実質完了し、machine は 0147 に残るため superseded にした（0193）。