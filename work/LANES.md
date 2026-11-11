# 実行レーン（変更レーン）

[parallel-change.md](../docs/parallel-change.md) の運用。設計の所有単位（D049 の L0〜L9）は [BOARD.md](BOARD.md)。
ここには**同時に流している変更だけ**を書く。2026-11-11 時点。

## 現在

0145 は done（b67262e）で main に commit 済み。E6（0150）は review PASS で、このブランチに含む（main へ統合待ち）。0188 / 0144 / 0143 / 0183 / 0185 / 0186 / 0187 はレビュー PASS・ローカル commit 済みで、main に統合済み。

| レーン | issue | 状態 | 次の統合 |
| --- | --- | --- | --- |
| E1 | [0188](issues/0188-graphql-only-contract.md) GraphQL を唯一の契約にする | done（66fc2ea）・統合済み | — |
| E2 | [0144](issues/0144-cf-deploy-env.md) 配備と環境（cf CLI・cloudflare.config.ts・秘密の投入） | done（648730a, PASS）・統合済み | — |
| E3 | [0143](issues/0143-secret-placement.md) 秘密の配置（gateway・git はマシン・DEK） | done（4073bc0, PASS）・統合済み | — |
| E4 | 統合・テスト基盤（このセッション） | 0187 と store test 分割を統合（b883f3f / 689f4c1） | — |
| E5 | [0145](issues/0145-worker-edge.md) Worker の入口（認証境界・ルーティング・相関 ID） | done（b67262e, PASS）・main に commit | — |
| E6 | [0150](issues/0150-store-d1-do-backend.md) store を D1 専用にする | done（bd1fabe, review PASS）・このブランチ | main へ統合 |

- 0187 は TSDoc / doctest / tsdown / TypeDoc を 7 commit（be0fbb1..b883f3f）で統合し、store.test の機能分割を 689f4c1 で追加した。現在の main は 0144 の rebase 後（aa1ac20 以降）。
- 0144 は `tools/deploy/`、gate の deploy stage、`package.json` / lock を統合した。root lock owner の変更は完了している。
- 0031 は done（CI 接続は受入条件ごと 0041 へ移管）。0141 は `in-progress` のまま、次の変更レーン候補。0037 は 0188 が superseded した。
- 0150 は `node:sqlite` を削除し、D1 専用の store と miniflare の実 SQLite のテストに移した（D064）。このブランチに commit 済みで、0145 の上に rebase 済み。main へ統合待ち。

## 統合待ち

0150（review PASS、0145 の上に rebase 済み）を main へ統合する。0175 / 0183 / 0185 / 0188 / 0144 / 0143 / 0145 / 0186 / 0187 は main に統合済み。
0187 の統合時は `npm run check`（193 tests、build、knip）、store test 分割後は 194 tests、0144 統合後は 201 tests で通過した。

## 次の変更レーン候補

| 候補 | 依存 | touches | 判定 |
| --- | --- | --- | --- |
| [0141](issues/0141-durability-contract.md) 耐久の契約 | 0140 done | `docs/durability.md`, `docs/workspace.md`, `packages/core/src/durability.ts` | 第1候補 |
| [0145](issues/0145-worker-edge.md) Worker の入口 | 0144 done | `packages/server/src/edge/`, server tests | **done**（b67262e, PASS） |
| [0142](issues/0142-lease-fencing.md) lease と fencing | 0141 未マージ | `packages/core/src/lease.ts` | 0141 後 |
| [0176](issues/0176-graphql-endpoint.md) /graphql | 0145 / 0175 未マージ | `packages/server/src/graphql/` | 0145 後 |
| 0177〜0180 | 0176 / 0145 | web / codegen | 0176 後 |
| 0184 / 0186 / 0187 | — | — | done。候補から外す |

0141 を次に開く。0142 は 0141 の後。0176 以降は 0145 / 0150 の outcome を見てから順を決める。

## 更新の規則

- 開始時に、issue / owner / reviewer / `touches` / 次の統合を書く。
- 終了時に、状態（作業中 / レビュー待ち / 統合待ち / 止まっている理由）を更新する。
- 4本目を足さない。止まったレーンは入れ替える。
- 数値（リードタイム、レビュー待ち、統合待ち、競合）は [parallel-change.md](../docs/parallel-change.md) の「計測」に合わせる。
