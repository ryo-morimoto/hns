# 実行レーン（変更レーン）

[parallel-change.md](../docs/parallel-change.md) の運用。設計の所有単位（D049 の L0〜L9）は [BOARD.md](BOARD.md)。
ここには**同時に流している変更だけ**を書く。2026-11-10 時点。

## 現在

| レーン | issue | 所有するパス | owner | reviewer | 状態 | 次の統合 |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | [0188](issues/0188-graphql-only-contract.md) GraphQL を唯一の契約にする | `packages/core/src`, `packages/core/README.md`, `packages/store/src/schemas.ts`, `packages/web/src`, `packages/web/package.json`, `package-lock.json`, `docs/{decisions,packages,auth,typescript,review,automation}.md`, `docs/design/http.md`, `AGENTS.md`, `work/BOARD.md` | — | reviewer-0188 | review PASS（8b45bd7, fix 未 commit）・統合待ち | 4 |
| E2 | [0143](issues/0143-secret-placement.md) 秘密の配置（gateway・git はマシン・DEK） | `docs/auth.md`, `docs/automation.md`, `work/issues/0147-machine-agent.md` | lead | reviewer-0143 | done（4073bc0, PASS） | 2 |
| E3 | 統合レーン（このセッション） | `docs/process.md`, `docs/parallel-change.md`, `work/README.md`, `work/LANES.md` | lead | — | 統合済み（5cb0ae5） | 1 |

- E3 は製品コードを書かない。3レーンの運用を文書化し、統合・レビュー・計測だけを行う。E1 / E2 のファイルを書かない。
- E2（0143）は docs-only、review 待ち。0185 は E2 の前のレーンとして統合済み（5cb0ae5）。
- E1（0188）は review FAIL（別レーンが修正中）。E2（0143）は `docs/auth.md` だけで E1 と交わらない。
- E1 の修正は `packages/store` / `docs/decisions.md` / `work/BOARD.md` を触る。E2 は触らない。
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
未コミット: 0188 の fix 一式（store schema の空文字拒否、core README / CHANGELOG、遷移テスト、指摘対応）。新規 `packages/core/test/workflow.test.ts` と `packages/store/test/schemas.test.ts` は untracked なので、commit 時に明示的に stage する。

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

0188 は review PASS（reviewer-0188）。fix 一式の commit と main での再確認の後に、E1 を 0144 へ入れ替える。
3本目は引き続き統合レーンとし、製品コードを書かない。

## 更新の規則

- 開始時に、issue / owner / reviewer / `touches` / 次の統合を書く。
- 終了時に、状態（作業中 / レビュー待ち / 統合待ち / 止まっている理由）を更新する。
- 4本目を足さない。止まったレーンは入れ替える。
- 数値（リードタイム、レビュー待ち、統合待ち、競合）は [parallel-change.md](../docs/parallel-change.md) の「計測」に合わせる。
