# 実行レーン（変更レーン）

[parallel-change.md](../docs/parallel-change.md) の運用。設計の所有単位（D049 の L0〜L9）は [BOARD.md](BOARD.md)。
ここには**同時に流している変更だけ**を書く。2026-11-10 時点。

## 現在

| レーン | issue | 所有するパス | owner | reviewer | 状態 | 次の統合 |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | [0188](issues/0188-graphql-only-contract.md) GraphQL を唯一の契約にする | `packages/core/src`, `packages/web/src`, `packages/web/package.json`, `package-lock.json`, `docs/{decisions,packages,auth,typescript,review,automation}.md`, `docs/design/http.md`, `AGENTS.md`, `work/BOARD.md` | — | — | 作業中 | 4 |
| E2 | [0185](issues/0185-tiers-removal.md) tiers の二重実行を廃止 | `packages/workspace/test/**`, `vitest.config.ts`, `docs/testing.md`, `docs/decisions.md`, `AGENTS.md` | — | reviewer-0185b | done（統合待ち） | 3 |
| E3 | 統合レーン（このセッション） | `docs/process.md`, `docs/parallel-change.md`, `work/README.md`, `work/LANES.md` | lead | — | 作業中 | 1 |

- E3 は製品コードを書かない。3レーンの運用を文書化し、統合・レビュー・計測だけを行う。E1 / E2 のファイルを書かない。
- E2 は review PASS。変更は未コミット。E1 の完了前に新しい変更レーンを開かない。
- E1 と E2 は `docs/decisions.md` と `AGENTS.md` が重なる。E2 は done なので同時に書かず、E2（3）→ E1（4）の順に統合して E1 を rebase する。
- 0141 / 0031 / 0037 は `in-progress` のまま更新が止まっている。レーンとして数える前に status を整理する
  （0037 は 0188 が superseded にする。0141 は 0188 の統合後に再開する）。

## 統合待ち

| 順 | issue | 状態 | 前提 |
| --- | --- | --- | --- |
| 1 | [0175](issues/0175-graphql-relay-foundation.md) | done、未コミット | なし |
| 2 | [0183](issues/0183-test-management.md) | done、未コミット | なし |
| 3 | [0185](issues/0185-tiers-removal.md) | done、未コミット | 0183 |
| 4 | [0188](issues/0188-graphql-only-contract.md) | in-progress | 0175 / 0183 / 0185 の統合後（core と web が重なる） |

統合は1本ずつ。rebase → `npm run check` → review PASS → merge → main で再確認。
0175 と 0183 は `package.json` / `package-lock.json` を触るので、この2本が終わるまで 0144 は開かない。

## 次の変更レーン候補

| 候補 | 依存 | E1 との重なり | 判定 |
| --- | --- | --- | --- |
| [0144](issues/0144-cf-deploy-env.md) 配備と環境 | 0140 done | `package.json` / lock が 0188 と重なる | 0188 の統合後に開く。第1候補 |
| [0143](issues/0143-secret-placement.md) 秘密の配置 | 0140 done | `docs/auth.md` が 0188 と重なる | 0188 の統合後 |
| [0141](issues/0141-durability-contract.md) 耐久の契約 | 0140 done | `packages/core/src` が 0188 と重なる | 0188 の統合後 |
| [0142](issues/0142-lease-fencing.md) lease と fencing | 0141 未マージ | — | 不可 |
| [0150](issues/0150-store-d1-do-backend.md) store の D1 | 0144 未マージ | — | 不可 |
| [0176](issues/0176-graphql-endpoint.md) /graphql | 0145 / 0175 未マージ | — | 不可 |
| [0184](issues/0184-vitest-assertions.md) expect 移行 | 0185 未マージ | テスト全体 | 0185 の統合後。0188 の後に開く |

いまは製品の変更レーンを3本目に足せない（0188 の `touches` が広く、どの `now` とも交わる）。
3本目は統合レーンにする。0188 の統合後に、E1 を 0144 へ入れ替える。

## 更新の規則

- 開始時に、issue / owner / reviewer / `touches` / 次の統合を書く。
- 終了時に、状態（作業中 / レビュー待ち / 統合待ち / 止まっている理由）を更新する。
- 4本目を足さない。止まったレーンは入れ替える。
- 数値（リードタイム、レビュー待ち、統合待ち、競合）は [parallel-change.md](../docs/parallel-change.md) の「計測」に合わせる。
