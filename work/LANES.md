# 実行レーン（変更レーン）

[parallel-change.md](../docs/parallel-change.md) の運用。設計の所有単位（D049 の L0〜L9）は [BOARD.md](BOARD.md)。
ここには**同時に流している変更だけ**を書く。2026-11-10 時点。

## 現在

| レーン | issue | 所有するパス | owner | reviewer | 状態 | 次の統合 |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | [0188](issues/0188-graphql-only-contract.md) GraphQL を唯一の契約にする | `packages/core/src`, `packages/core/README.md`, `packages/store/src/schemas.ts`, `packages/web/src`, `packages/web/package.json`, `package-lock.json`, `docs/{decisions,packages,auth,typescript,review,automation}.md`, `docs/design/http.md`, `AGENTS.md`, `work/BOARD.md` | — | reviewer-0188 | review FAIL（blocking 2, f4ca217） | 4 |
| E2 | [0185](issues/0185-tiers-removal.md) tiers の二重実行を廃止 | `packages/workspace/test/**`, `vitest.config.ts`, `docs/testing.md`, `docs/decisions.md`, `AGENTS.md` | — | reviewer-0185b | done（統合済み 5cb0ae5） | 3 |
| E3 | 統合レーン（このセッション） | `docs/process.md`, `docs/parallel-change.md`, `work/README.md`, `work/LANES.md` | lead | — | 統合済み（5cb0ae5） | 1 |

- E3 は製品コードを書かない。3レーンの運用を文書化し、統合・レビュー・計測だけを行う。E1 / E2 のファイルを書かない。
- E2 は review PASS、統合済み。E1 は review FAIL。store schema の空文字と core README / CHANGELOG を直して再 review する。新しい変更レーンは E1 の review PASS 後に開く。
- E1 と E2 は `docs/decisions.md` と `AGENTS.md` が重なる。E2 を先に統合し、E1 を rebase して 5cb0ae5 に含めた。
- 0141 / 0031 / 0037 は `in-progress` のまま更新が止まっている。レーンとして数える前に status を整理する
  （0037 は 0188 が superseded にする。0141 は 0188 の統合後に再開する）。

## 統合待ち

| 順 | issue | 状態 | 前提 |
| --- | --- | --- | --- |
| 1 | [0175](issues/0175-graphql-relay-foundation.md) | 統合済み（5cb0ae5） | なし |
| 2 | [0183](issues/0183-test-management.md) | 統合済み（5cb0ae5） | なし |
| 3 | [0185](issues/0185-tiers-removal.md) | 統合済み（5cb0ae5） | 0183 |
| 4 | [0188](issues/0188-graphql-only-contract.md) | 統合済み（5cb0ae5）・review 待ち | 0175 / 0183 / 0185 の統合後（core と web が重なる） |

統合は1本ずつ。rebase → `npm run check` → review PASS → merge → main で再確認。5cb0ae5 は `npm run check`（162 tests、build、knip）通過後に作成した。
0175 / 0183 は統合済みなので、0144 の `package.json` / `package-lock.json` の lock は空いた。
未コミット: `packages/store/src/schemas.ts` に空文字を拒否する変更が1件（2026-11-10 23:43）。0188 の follow-up として review してから統合する。

## 次の変更レーン候補

| 候補 | 依存 | 0188 との重なり | 判定 |
| --- | --- | --- | --- |
| [0144](issues/0144-cf-deploy-env.md) 配備と環境 | 0140 done | `package.json` / lock が 0188 と重なった | 0188 の review 後に開く。第1候補 |
| [0143](issues/0143-secret-placement.md) 秘密の配置 | 0140 done | `docs/auth.md` が 0188 と重なった | 0188 の review 後 |
| [0141](issues/0141-durability-contract.md) 耐久の契約 | 0140 done | `packages/core/src` が 0188 と重なった | 0188 の review 後 |
| [0142](issues/0142-lease-fencing.md) lease と fencing | 0141 未マージ | — | 不可 |
| [0150](issues/0150-store-d1-do-backend.md) store の D1 | 0144 未マージ | — | 不可 |
| [0176](issues/0176-graphql-endpoint.md) /graphql | 0145 / 0175 未マージ | — | 不可 |
| [0184](issues/0184-vitest-assertions.md) expect 移行 | 0185 未マージ | テスト全体 | 0185 は統合済み。0188 の review 後に開く。優先度は plan |

0188 は review FAIL（blocking 2）。修正と再 review の後に、E1 を 0144 へ入れ替える。
3本目は引き続き統合レーンとし、製品コードを書かない。

## 更新の規則

- 開始時に、issue / owner / reviewer / `touches` / 次の統合を書く。
- 終了時に、状態（作業中 / レビュー待ち / 統合待ち / 止まっている理由）を更新する。
- 4本目を足さない。止まったレーンは入れ替える。
- 数値（リードタイム、レビュー待ち、統合待ち、競合）は [parallel-change.md](../docs/parallel-change.md) の「計測」に合わせる。
