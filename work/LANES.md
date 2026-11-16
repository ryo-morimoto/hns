# 実行レーン（変更レーン）

[parallel-change.md](../docs/parallel-change.md) の運用。設計の所有単位（D049 の L0〜L9）は [BOARD.md](BOARD.md)。
ここには**同時に流している変更だけ**を書く。2026-11-17 時点。

## 現在

`now` は 5 件（0147 / 0151 / 0156 / 0159 / 0190）。同時に流すのは 3 本で、いまは 0190 / 0151 / 0147。
0190 と 0151 はレビュー中、0147 は作業中。0142 は done（460c00b、review PASS）で 0156 を開けた。
0156 は 0190 の統合後に開き、0159 は次の枠。完了したレーンは BOARD の履歴に残る。

| レーン | issue | 所有するパス | owner / reviewer | 状態 | 次の統合 |
| --- | --- | --- | --- | --- | --- |
| E15 | [0190](issues/0190-workspace-debt.md) workspace の低負債 | `packages/workspace/` | lane-0190 / reviewer-0190 | レビュー中（a5c674e） | 1（小さい・依存なし） |
| E16 | [0151](issues/0151-provider-gateway.md) provider gateway | `server/src/gateway/`, `server/test/gateway/`, `store/src/migrations/`, `tools/deploy/` | lane-0151 / reviewer-0151 | レビュー中（17f0f9b） | 2（store migration の枠を持つ） |
| E17 | [0147](issues/0147-machine-agent.md) マシンエージェント | `packages/machine/`, `docs/packages.md`, `oxlint.config.ts`, `vitest.config.ts`, lock | lane-0147 / reviewer-0147 | 作業中（lock owner） | 3（依存なし・新パッケージ） |
| — | [0156](issues/0156-journal-in-do.md) Workspace DO の骨格 | `server/src/do/workspace.ts`, `server/test/do/workspace.test.ts` | 未割当 / 未割当 | 待機（0190 の統合後） | 4 |
| — | [0159](issues/0159-live-ws.md) ライブ WS | `server/src/ws.ts`, `core/src/stream.ts`, `do/session.ts`, `web/src/live/`, `web/src/app/` | 未割当 / 未割当 | 待機（3 本のどれかが空いたら） | 5 |

- E15 / E16 / E17 の `touches` は交わらない。共有ファイルは E17 が lock、E16 が store migration と `tools/deploy/` を持つ。
- E16 が `tools/deploy/` を持つあいだ、0160 / 0161 は開かない（直列化点）。
- `server/src/index.ts` / `edge/handler.ts` / `edge/worker.ts` は 0145 の所有のまま。0159 は 0151 の統合後に開く。
- **design 軸（D076）**: `now` は `design: agreed` かつ依存充足。0153 / 0059 は順番待ち、設計待ちの 13 件は設計レビュー待ち。
- lead は 3 本の review と統合、BOARD / LANES の更新を持つ。

## 統合待ち

なし。統合順は 0190 → 0151 → 0147（小さい順・共有ファイルの所有者順）。レビュー PASS のものから 1 本ずつ。

## 次の変更レーン候補

- **順番待ち（design: agreed・依存充足）**: [0153](issues/0153-r2-object-store.md)（0190 → 0191 の後）、[0059](issues/0059-agent-observe-bash.md)。
- **依存待ちの agreed**: 0154 / 0155 / 0157 / 0162 / 0163 / 0166 / 0167 / 0168 / 0169（依存が解けたら）。
- **設計待ち**: [BOARD.md](BOARD.md) の 13 件。設計レビュー（D069 の設計層）で `design-ref` を書いて `agreed` にしてから。

## 更新の規則

- 開始時に、issue / owner / reviewer / `touches` / 次の統合を書く。
- 終了時に、状態（作業中 / レビュー待ち / 統合待ち / 止まっている理由）を更新する。
- 4本目を足さない。止まったレーンは入れ替える。
- 数値（リードタイム、レビュー待ち、統合待ち、競合）は [parallel-change.md](../docs/parallel-change.md) の「計測」に合わせる。
