# 実行レーン（変更レーン）

[parallel-change.md](../docs/parallel-change.md) の運用。設計の所有単位（D049 の L0〜L9）は [BOARD.md](BOARD.md)。
ここには**同時に流している変更だけ**を書く。2026-11-17 時点。

## 現在

`now` は 3 件（0147 / 0156 / 0159）。同時に流すのは 3 本で、いまは 0147 / 0156 / 0159。
0190（6eb2a21）と 0151（624052c）は done で main に統合済み。0147 はレビュー中、0156 と 0159 は作業中。
完了したレーンは BOARD の履歴に残る。

| レーン | issue | 所有するパス | owner / reviewer | 状態 | 次の統合 |
| --- | --- | --- | --- | --- | --- |
| E17 | [0147](issues/0147-machine-agent.md) マシンエージェント | `packages/machine/`, `docs/packages.md`, `oxlint.config.ts`, `vitest.config.ts`, lock | lane-0147 / reviewer-0147 | レビュー中（fbdd230） | 1（新パッケージ・lock owner） |
| E18 | [0156](issues/0156-journal-in-do.md) Workspace DO の骨格 | `packages/server/src/do/workspace.ts`, `packages/server/test/do/workspace.test.ts` | lane-0156 / 未割当 | 作業中 | 2 |
| E19 | [0159](issues/0159-live-ws.md) ライブ WS | `packages/server/src/ws.ts`, `packages/core/src/stream.ts`, `packages/server/src/do/session.ts`, `packages/web/src/live/`, `packages/web/src/app/` | lane-0159 / 未割当 | 作業中 | 3 |

- `tools/deploy/` は 0151 の統合で解放。0160 / 0161 は次の枠。
- `server/src/index.ts` / `edge/handler.ts` / `edge/worker.ts` は 0159 が必要なら `touches` に足す（他のレーンは触らない）。
- **design 軸（D076）**: `now` は `design: agreed` かつ依存充足。0153 / 0059 は順番待ち、設計待ちの 15 件は設計レビュー待ち。
- lead は review と統合、BOARD / LANES の更新を持つ。

## 統合待ち

- 0147: reviewer-0147 の判定待ち。PASS 後に rebase → gate → merge。
- 0156 / 0159: 実装中。PASS 後に 1 本ずつ。
- 統合順は 0147 → 0156 → 0159。

## 次の変更レーン候補

- **順番待ち（design: agreed・依存充足）**: [0153](issues/0153-r2-object-store.md)（0190 → 0191 の後）、[0059](issues/0059-agent-observe-bash.md)。
- **依存待ちの agreed**: 0154 / 0155 / 0157 / 0162 / 0163 / 0166 / 0167 / 0168 / 0169（依存が解けたら）。
- **設計待ち**: [BOARD.md](BOARD.md) の 15 件。設計レビュー（D069 の設計層）で `design-ref` を書いて `agreed` にしてから。

## 更新の規則

- 開始時に、issue / owner / reviewer / `touches` / 次の統合を書く。
- 終了時に、状態（作業中 / レビュー待ち / 統合待ち / 止まっている理由）を更新する。
- 4本目を足さない。止まったレーンは入れ替える。
- 数値（リードタイム、レビュー待ち、統合待ち、競合）は [parallel-change.md](../docs/parallel-change.md) の「計測」に合わせる。
