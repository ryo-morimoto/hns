# コストの実測

2026-11-17。issue 0163 の計測（1 ターンあたりの DO 行・リクエスト・R2 オブジェクト）。
**実測値の置き場はこのファイル 1 箇所**（issue と docs/limits.md はここを指す）。

## 条件

- 実装: `packages/server/src/cost/`（Session DO の送信前の上限判定と、ターン終了時の記録）。
- ランタイム: pi-durable 1.5.0 の実 Harness。SQLite は Node の `node:sqlite`（workerd ではなく、
  Durable Object の `sql.exec` と同じ形のアダプタ）。
- モデル: faux（`faux/echo`）。**text 1 ターン、ツール無し。**
- 計測コード: `packages/server/src/do/session-cost.test.ts`（同じ数字を回帰テストとして固定している）。
- 行は「増えた行」（実行前後の `COUNT(*)` 差）。更新で書き直された行は差に出ないため、**行書き込みの下限**。

## 実測

| 指標 | 1 ターン |
| --- | --- |
| DO 行（増分） | **9** |
| DO リクエスト | **1**（送信 RPC 1 回） |
| R2 オブジェクト | **0**（ターン中の put は 0157 の書き込み経路から） |

9 行の内訳:

| 表 | 行 |
| --- | --- |
| `hns_sessionrecord_ids` | 4 |
| `hns_sessionentries` | 2 |
| `hns_sessionsubmissions` | 1 |
| `hns_sessiondocument_revisions` | 1 |
| `hns_sessiontasks` | 1 |

## 月 1 万ターンへの外挿

| 指標 | 10,000 ターン / 月 | 既定の上限 | 比率 |
| --- | --- | --- | --- |
| DO 行 | 90,000 | 50,000,000 | 0.18% |
| DO リクエスト | 10,000 | 1,000,000 | 1% |
| R2 オブジェクト | 0 | 1,000,000 | 0% |

既定の上限は `cost_limits` の seed（docs/durability.md §7 の無料枠）。**支配的なのはモデル代**で、
プラットフォーム側は 1 桁小さい。だから token 単位 commit のような桁の変化を検出できることが要る
（`session-cost.test.ts` の行数上限 24。token ごとなら 100〜500 倍になる）。

## 読み方

- ツールを使うターンは行が増える（1 op = 1 intent/outcome + イベント）。実ターンのツール込みの計測は
  [poc/cf-harness/RESULTS.md](../../work/poc/cf-harness/RESULTS.md) の「1 ターン 4 op で ~10 行」と整合する。
- 更新の書き直しは行の増分に出ないので、DO の「行書き込み」課金に対してはこの数字は下限。桁を見るには足りる。
- 計測をやり直す: `npm test -w @hns/server` の `session-cost.test.ts` が同じ表を回す。数字が変わったら
  この表と `ROW_BUDGET`（24）を見直す。
