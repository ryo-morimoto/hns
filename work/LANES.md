# 実行レーン（変更レーン）

[parallel-change.md](../docs/parallel-change.md) の運用。設計の所有単位（D049 の L0〜L9）は [BOARD.md](BOARD.md)。
ここには**同時に流している変更だけ**を書く。2026-11-17 時点。

## 現在

`now` は 5 件。同時に流すのは 3 本で、いまは 0190 / 0151 / 0147。0142 は lead が 3 本と交わらないうちに閉じる。
完了したレーンは BOARD の履歴に残る（E1〜E14 は main に統合済み）。

| レーン | issue | 所有するパス | owner / reviewer | 状態 | 次の統合 |
| --- | --- | --- | --- | --- | --- |
| E15 | [0190](issues/0190-workspace-debt.md) workspace の低負債 | `packages/workspace/` | lane-0190 / reviewer-0190 | 作業中 | 1（小さい・依存なし） |
| E16 | [0151](issues/0151-provider-gateway.md) provider gateway | `server/src/gateway/`, `server/test/gateway/`, `store/src/migrations/`, `tools/deploy/` | lane-0151 / reviewer-0151 | 作業中 | 2（store migration の枠を持つ） |
| E17 | [0147](issues/0147-machine-agent.md) マシンエージェント | `packages/machine/`, `docs/packages.md`, `oxlint.config.ts`, `vitest.config.ts`, lock | lane-0147 / reviewer-0147 | 作業中（lock owner） | 3（依存なし・新パッケージ） |
| L | [0142](issues/0142-lease-fencing.md) lease と fencing | `core/src/lease.ts`, `core/src/index.ts`, `core/{README,CHANGELOG}.md`, `docs/durability.md`, `docs/workspace.md` | lead / reviewer-0142 | 先行して閉じる | 0（0156 を開ける） |

- E15 / E16 / E17 の `touches` は交わらない。共有ファイルは E17 が lock、E16 が store migration と `tools/deploy/` を持つ。
- E16 が `tools/deploy/` を持つあいだ、0160 / 0161 は開かない（直列化点）。
- `server/src/index.ts` / `edge/handler.ts` / `edge/worker.ts` は 0145 の所有のまま。0159 は 0151 の統合後に開く。
- 待機: [0159](issues/0159-live-ws.md)（3 本のどれかが空いたら E18）。
- lead は 3 本の review と統合、BOARD / LANES の更新を持つ。実装は 0142 だけ。

## 統合待ち

なし。

## 次の変更レーン候補

昇格の条件と順序は [BOARD.md](BOARD.md) の「次の昇格」に置く。依存が解けたら lead が `now` に上げ、ここに1行足す。

| 候補 | 前提 | レーン | 判定 |
| --- | --- | --- | --- |
| [0156](issues/0156-journal-in-do.md) Workspace DO の骨格 | 0142 done | L4 | 0142 の直後 |
| [0191](issues/0191-workspace-perf.md) workspace の性能 | 0190 done | L4 | 0190 と同じレーンで続ける |
| [0152](issues/0152-real-provider.md) 実プロバイダ | 0151 done | L9 | 0151 と同じレーンで続ける |
| [0153](issues/0153-r2-object-store.md) R2 | 0191 done | L4 | workspace の窓が閉じてから |
| [0048](issues/0048-store-identity.md) store/identity | 0151 done（migration の枠） | L1 / L6 | 0069 / 0070 が続く |
| [0194](issues/0194-machine-sandbox.md) / [0148](issues/0148-machine-registry.md) / [0165](issues/0165-safety-reeval.md) | 0147 done | L3 | 0148 より 0194 / 0165 を先に置いてよい |
| [0160](issues/0160-ui-delivery.md) UI の配信 | 0159 done | L7 | 0105 / 0103 の順序は 0182 |
| [0149](issues/0149-d1-projection.md) 索引 | 0151 done + GraphQL rescope | L5 | 0115 / 0121 の前提 |

## 更新の規則

- 開始時に、issue / owner / reviewer / `touches` / 次の統合を書く。
- 終了時に、状態（作業中 / レビュー待ち / 統合待ち / 止まっている理由）を更新する。
- 4本目を足さない。止まったレーンは入れ替える。
- 数値（リードタイム、レビュー待ち、統合待ち、競合）は [parallel-change.md](../docs/parallel-change.md) の「計測」に合わせる。
