# Board

残作業の索引。1 issue = 1ファイル（`work/issues/`）。ファイル形式は [README.md](README.md)。

| # | 作業 | 状態 | 依存 |
| --- | --- | --- | --- |
| [0001](issues/0001-t02-remainder.md) | T-02 の残り（監査・Root差し替え・Worker越し） | open | — |
| [0002](issues/0002-mutation-crash.md) | T-03/T-04 Mutation の故障注入 | open | 0001 |
| [0003](issues/0003-walking-skeleton.md) | Workspace Walking Skeleton | open | 0002 |
| [0004](issues/0004-dev-env.md) | 開発環境の固定（node） | open | — |

## ユーザー判断待ち

| # | 論点 | 案 |
| --- | --- | --- |
| D-1 | ADR-0001 の採用 | 採用 |
| D-2 | 要件#2 の解釈（各マシンで Core Agent / 中央Harness+遠隔Tool） | まず後者で PoC |
| D-3 | MVP 範囲 | 1マシンで 会話→編集→差分→再開 |
| D-4 | プロダクト名（`hns`） | 未定のまま進行可 |

## 制約

- 危険な Tool は Worker 認可が完成するまで公開しない。
- 外部副作用の exactly-once を前提にしない。
