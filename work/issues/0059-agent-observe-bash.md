# 0059: agent の bash も観測する

status: open
priority: plan
design: agreed
design-ref: 設計を変えない（0034 の観測の揃え）
depends-on: 0034
touches: packages/agent

## Goal

`read_file` / `write_file` は `tool.call` / `tool.result` を出すが、`createBashTool()` を素で登録している
ので bash だけイベントが出ない。観測を揃える。

## Acceptance criteria

- [ ] bash の実行でも `tool.call` / `tool.result`（ok・ms）が出る
- [ ] 失敗（非ゼロ終了・sandbox 拒否）も `tool.result` に載る
- [ ] 3 ツールすべてで観測が出ることを回帰テストで固定する

## Notes

- pi-durable の `wrapTool` で包むか、`GenerationHooks.afterTools` で拾うかのどちらか。
- `tool.result` の `ok` は `isError` に合わせる（bash は exit code でも判定する）。

## Log

- 2026-11-07: 作成（コードレビューで bash だけ観測が無いのを見つけた）。
