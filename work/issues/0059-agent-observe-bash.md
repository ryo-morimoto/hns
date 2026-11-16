# 0059: agent の bash も観測する

status: in-progress
priority: now
design: agreed
design-ref: 設計を変えない（0034 の観測の揃え）
depends-on: 0034
touches: packages/agent/src/tools.ts, packages/agent/test/integration/bash.test.ts, packages/agent/CHANGELOG.md

## Goal

`read_file` / `write_file` は `tool.call` / `tool.result` を出すが、`createBashTool()` を素で登録している
ので bash だけイベントが出ない。観測を揃える。

## Acceptance criteria

- [ ] bash の実行でも `tool.call` / `tool.result`（ok・ms）が出る
- [ ] 失敗（非ゼロ終了・sandbox 拒否）も `tool.result` に載る
- [ ] 3 ツールすべてで観測が出ることを回帰テストで固定する

## テスト条件

| ID  | 条件（Given → When → Then）                                                                     | リスク | 出所   |
| --- | ------------------------------------------------------------------------------------------------ | ------ | ------ |
| C1  | read_file が成功 → 実行 → tool.call と tool.result（ok true、ms は非負）が 1 組出る              | 中     | 受入 1 |
| C2  | write_file が成功 → 実行 → tool.call と tool.result（ok true）が 1 組出る                        | 中     | 受入 1 |
| C3  | bash が終了コード 0 → 実行 → tool.call と tool.result（ok true）が 1 組出る                      | 高     | 受入 1 |
| C4  | bash が終了コード 3 → 実行 → tool.result が ok false で出る                                      | 高     | 受入 2 |
| C5  | sandbox が root 外への書き込みを拒否（非ゼロ終了）→ tool.result が ok false、脱出ファイルは無い  | 高     | 受入 2 |
| C6  | 実行が throw する（timeout）→ tool.result が ok false で出て、ターンは終端まで進む               | 中     | 受入 2 |
| C7  | 1 ターンで read_file / write_file / bash を呼ぶ → 3 ツールすべてで call と result が 1 組ずつ出る | 高     | 受入 3 |

- 観測が出ないのは `onEvent` 未指定のとき（既存の 3 ツール共通の契約なので追加では試験しない）。sandbox が無ければ bash 自体が登録されない。
- C1 は既存のコロケートテストが固定している。C2〜C7 は同じターンで bash を実行する（bubblewrap が子プロセスを起動する）ため integration 層に置く。

## テスト設計

| ID  | 条件      | 技法                 | 層          | テスト                                                                |
| --- | --------- | -------------------- | ----------- | --------------------------------------------------------------------- |
| T1  | C1        | ユースケース         | unit        | `src/agent.test.ts` "observation events name the tool, its outcome…"  |
| T2  | C2, C3, C7 | ユースケース         | integration | `test/integration/bash.test.ts` "read_file, write_file, and bash each…" |
| T3  | C4        | 同値分割（0 / 非 0） | integration | `test/integration/bash.test.ts` "a nonzero exit is a failed tool result" |
| T4  | C5        | 故障注入             | integration | `test/integration/bash.test.ts` "bash runs inside the root and cannot…" |
| T5  | C6        | 故障注入             | integration | `test/integration/bash.test.ts` "a command that times out still…"     |

- `ok` は `isError` と、bash の `structuredOutput.exitCode` の両方から決める。exit code が 0 でない実行を成功と記録しない。
- T1 は既存テストで、read_file の call / result と agent.response を固定している。T2 が 3 ツールの回帰。
- throw する実行（timeout）も tool.result を出してから伝播する。bash の timeout と exec 失敗は値ではなく throw で返るため。

## Notes

- pi-durable の `wrapTool` で包むか、`GenerationHooks.afterTools` で拾うかのどちらか。
- `tool.result` の `ok` は `isError` に合わせる（bash は exit code でも判定する）。

## Log

- 2026-11-07: 作成（コードレビューで bash だけ観測が無いのを見つけた）。
- 2026-11-17: 第2波で now へ（0147 / 0159 の統合後）。BOARD は別セッションの編集が落ち着いてから lead が反映。
- 2026-11-17: 実装。`createBashTool()` の `execute` を `observed()` で包み、read_file / write_file と同じ
  `tool.call` / `tool.result` を出す。`ok` は `isError` と `structuredOutput.exitCode` で判定し、throw する実行
  （timeout・exec 失敗）も tool.result を出してから伝播する。3 ツールの回帰を integration に置いた。
  `wrapTool` は使わず、登録する `execute` を `observed()` で包んだ。registry にラッパー拡張を足さず、
  既存の観測を 1 か所で共有するため。
