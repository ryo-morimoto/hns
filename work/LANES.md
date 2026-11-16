# 実行レーン（変更レーン）

[parallel-change.md](../docs/parallel-change.md) の運用。設計の所有単位（D049 の L0〜L9）は [BOARD.md](BOARD.md)。
ここには**同時に流している変更だけ**を書く。2026-11-11 時点。

## 現在

0141（E8）と 0146（E7）が実装中。0145 は done（b67262e）、E6（0150）は review PASS で main に統合済み（cff01f4）。0188 / 0144 / 0143 / 0183 / 0185 / 0186 / 0187 も main に統合済み。3本目は 0189（E9、D1 の開通）で、統合後に同じレーンで 0151 を開く。

| レーン | issue | 状態 | 次の統合 |
| --- | --- | --- | --- |
| E1 | [0188](issues/0188-graphql-only-contract.md) GraphQL を唯一の契約にする | done（66fc2ea）・統合済み | — |
| E2 | [0144](issues/0144-cf-deploy-env.md) 配備と環境（cf CLI・cloudflare.config.ts・秘密の投入） | done（648730a, PASS）・統合済み | — |
| E3 | [0143](issues/0143-secret-placement.md) 秘密の配置（gateway・git はマシン・DEK） | done（4073bc0, PASS）・統合済み | — |
| E4 | 統合・テスト基盤（このセッション） | 0187 と store test 分割を統合（b883f3f / 689f4c1） | — |
| E5 | [0145](issues/0145-worker-edge.md) Worker の入口（認証境界・ルーティング・相関 ID） | done（b67262e, PASS）・main に commit | — |
| E6 | [0150](issues/0150-store-d1-do-backend.md) store を D1 専用にする | done（bd1fabe, review PASS）・main に統合（cff01f4） | — |
| E10 | [0176](issues/0176-graphql-endpoint.md) Worker に /graphql を載せる | done（09ff2f8、review PASS）・main に統合 | — |
| E11 | [0177](issues/0177-global-id.md) global id | done（39e7b54、review PASS）・main に統合 | — |
| E12 | [0178](issues/0178-web-relay-environment.md) web の Relay environment | done（92c4c7a、review PASS）・main に統合 | — |
| E13 | [0179](issues/0179-sidebar-relay.md) サイドバーを Relay で読む | done（31a8276、review PASS）・main に統合 | — |
| E14 | [0180](issues/0180-codegen-gate.md) codegen をゲートに組み込む | done（HEAD、review PASS）・main に統合 | — |
| E7 | [0146](issues/0146-session-do.md) Session DO（PiHarness・会話・run） | done（024bb03、review PASS）・main に統合 | — |
| E8 | [0141](issues/0141-durability-contract.md) 耐久の契約 | 実装中（docs / core の型） | 0140 done |
| E9 | [0189](issues/0189-d1-wiring.md) Worker から D1 の store を開通させる | done（5783a92、review PASS）・main に統合 | 完了 |

- 0187 は TSDoc / doctest / tsdown / TypeDoc を 7 commit（be0fbb1..b883f3f）で統合し、store.test の機能分割を 689f4c1 で追加した。現在の main は 0144 の rebase 後（aa1ac20 以降）。
- 0144 は `tools/deploy/`、gate の deploy stage、`package.json` / lock を統合した。root lock owner の変更は完了している。
- 0031 は done（CI 接続は受入条件ごと 0041 へ移管）。0141 は `in-progress` のまま、次の変更レーン候補。0037 は 0188 が superseded した。
- 0150 は `node:sqlite` を削除し、D1 専用の store と miniflare の実 SQLite のテストに移した（D064）。0145 の上に rebase して main に統合済み（cff01f4）。

## 統合待ち

なし。0175 / 0183 / 0185 / 0188 / 0144 / 0143 / 0145 / 0150 / 0186 / 0187 は main に統合済み。
0187 の統合時は `npm run check`（193 tests、build、knip）、store test 分割後は 194 tests、0144 統合後は 201 tests、0150 統合後は 249 tests で通過した。

## 次の変更レーン候補

| 候補 | 依存 | touches | 判定 |
| --- | --- | --- | --- |
| [0141](issues/0141-durability-contract.md) 耐久の契約 | 0140 done | `docs/durability.md`, `docs/workspace.md`, `packages/core/src/durability.ts` | **E8 で実装中** |
| [0146](issues/0146-session-do.md) Session DO | 0145 done | `packages/server/src/do/`, `packages/agent/` | **E7 で実装中** |
| [0189](issues/0189-d1-wiring.md) D1 の開通 | 0145 / 0150 done | `store/src/migrations/`, `server/src/edge/env.ts`, `server/package.json`, `package-lock.json`（空き）, `tools/deploy/cloudflare.config.ts`, `ARCH.md` | **E9（3本目、design review PASS）** |
| [0151](issues/0151-provider-gateway.md) provider gateway | 0143 / 0144 done | `server/src/gateway/`, store の migration | 0189 の後、同じレーン |
| [0190](issues/0190-workspace-debt.md) → [0191](issues/0191-workspace-perf.md) | 0141 未マージ | `packages/workspace/` | 0141 の統合後。L4 が開く前 |
| [0142](issues/0142-lease-fencing.md) lease と fencing | 0141 未マージ | `packages/core/src/lease.ts` | 0190 / 0191 の後 |
| [0153](issues/0153-r2-object-store.md) ∥ [0156](issues/0156-journal-in-do.md) | 0141 / 0142 | `workspace/src/objects.ts`, `server/src/do/workspace.ts` | 0142 の後 |
| [0147](issues/0147-machine-agent.md) → [0194](issues/0194-machine-sandbox.md) | 0145 done | `packages/machine/` | 0189 か 0151 の後 |
| [0176](issues/0176-graphql-endpoint.md) /graphql → 0177〜0180 | 0146 未マージ | `packages/server/src/graphql/` | 0146 の統合後 |
| 0184 / 0186 / 0187 / 0188 | — | — | done。候補から外す |

0141 の統合後は 0190 → 0191 を先に置く（workspace の窓が L4 で閉じるため）。0142 → 0153 ∥ 0156 が続く。
0189 の統合後は同じレーンで 0151、その後に 0147。0176 以降は 0146 の統合直後。

## 更新の規則

- 開始時に、issue / owner / reviewer / `touches` / 次の統合を書く。
- 終了時に、状態（作業中 / レビュー待ち / 統合待ち / 止まっている理由）を更新する。
- 4本目を足さない。止まったレーンは入れ替える。
- 数値（リードタイム、レビュー待ち、統合待ち、競合）は [parallel-change.md](../docs/parallel-change.md) の「計測」に合わせる。