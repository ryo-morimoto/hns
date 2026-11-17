# 実行レーン（変更レーン）

[parallel-change.md](../docs/parallel-change.md) の運用。設計の所有単位（D049 の L0〜L9）は [BOARD.md](BOARD.md)。
ここには**同時に流している変更だけ**を書く。2026-11-17 時点。

## 現在

第2波は完了（0059 / 0153 / 0169 / 0163 / 0154 / 0157 / 0162 が main）。いまの `now` は 3 件（0220 / 0227 / 0198）。
0220 / 0227 は別セッションが編集中（untracked）。こちらは **0198（GraphQL Mutation）** を進める。

| レーン | issue | 所有するパス | owner / reviewer | 状態 | 次の統合 |
| --- | --- | --- | --- | --- | --- |
| E20 | [0198](issues/0198-graphql-mutation.md) GraphQL Mutation 面 | `packages/core/src/graphql/`, `packages/core/test/graphql/`, `packages/server/src/graphql/`, `packages/server/test/graphql/` | lane-0198 / 未割当 | 作業中 | 1（PASS 後） |

- 0220 / 0227 は別セッションの worktree / commit 待ち。こちらの BOARD / LANES には着手レーンとして書かない。
- **design 軸（D076）**: `now` は `design: agreed` かつ依存充足。順番待ちは 0048 / 0049 / 0103 / 0149 / 0152 / 0160 / 0165 / 0181 / 0182 / 0191 / 0194 / 0199。
- lead は review と統合、BOARD / LANES の更新を持つ。

## 統合待ち

- 0198: 実装完了待ち（PASS 後に rebase → gate → merge）。

## 次の変更レーン候補

- **順番待ち（design: agreed・依存充足）**: 0199、0160、0181、0182、0043、0048、0049、0103、0149、0152、0165、0191、0194。
- **依存待ちの agreed**: 0122 / 0127 / 0155 / 0166 / 0167 / 0168（依存が解けたら）。
- **別セッション**: 0220 / 0227（untracked）。commit されたら board の `now` に従う。

## 更新の規則

- 開始時に、issue / owner / reviewer / `touches` / 次の統合を書く。
- 終了時に、状態（作業中 / レビュー待ち / 統合待ち / 止まっている理由）を更新する。
- 4本目を足さない。止まったレーンは入れ替える。
- 数値（リードタイム、レビュー待ち、統合待ち、競合）は [parallel-change.md](../docs/parallel-change.md) の「計測」に合わせる。
