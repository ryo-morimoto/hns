# 0017: Workflow の最小（定義・検証・実行）

status: done
depends-on: 0016
touches: work/poc/app

## Goal

要件6。グラフを定義し、検証し、版を固定して実行し、ノードごとの結果を見られる。

## Acceptance criteria

- [x] グラフの検証（重複 ID・未知の参照・自己辺・循環）
- [x] 版付きの定義（編集で version +1、run は版を固定）
- [x] ノードの逐次実行とプロンプトの補間（`{{node}}`）
- [x] ノードの状態・プロンプト・出力・会話 ID を残す

## Result

- `workflow.mjs`: `validateGraph` / `topoOrder` / `interpolate`。
- ノードは当面 `agent` のみ。実行はサーバ内で逐次（トポロジカル順）。1ノード = 1会話。
- API: `/api/workflows`（GET/POST/PUT）、`/api/workflows/:id/runs`（POST）、`/api/runs`（GET）。
- 落ちた run は起動時に `interrupted` にする（再開はしない。D012）。
- **10/10 合格**。
