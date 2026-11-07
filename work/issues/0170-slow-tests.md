# 0170: 遅いテストをコミット前から外す

status: open
depends-on: -
touches: vitest.config.ts, tools/gate/stages.ts, package.json, docs/testing.md, AGENTS.md

## Goal

コミット前の test 段階から遅いテストを外し、push / CI に回す。
実測では workspace の 3 ファイル（`workspace.test.ts` 11.95s / `toctou.test.ts` 7.20s / `hardening.test.ts` 7.05s。
並列なので project 全体で 12.46s）と `agent.test.ts`（3.73s）が、test 段階 12.9 秒のほぼ全部を占める。

## Acceptance criteria

- [ ] `vitest.config.ts` の `projects` を速い層と遅い層に分ける（例: `workspace` から `workspace-slow`、`agent` から `agent-slow`）
- [ ] `tools/gate/stages.ts` の test 段階が、既定では速い層だけを回す
- [ ] `npm run check`（`--all`）は全層を回す（検出機会を落とさない）
- [ ] 遅い層だけを回すコマンドがある（`npm run gate test --all` か専用スクリプト）
- [ ] 実測: core 変更時の pre-commit が約 3 秒になる（現状 13 秒）
- [ ] `docs/testing.md` の層の定義と、どの層がコミットを止めるかを更新する

## Notes

- 分け方は project の追加だけで表現できる。ファイル単位の除外リストを別に持たない（定義を1か所に保つ）。
- 遅い層は「遅いから」ではなく「外部資源（bwrap・実ファイル・実時間）に触るから」で分ける。
  そうしないと、速くなったときに理由なく戻せなくなる。
- 既存の `npm test -w @hns/workspace` の意味を変えない（パッケージの全テストを回す）。

## やらないこと

- テスト自体の高速化（fixture・sandbox の見直し）はここではやらない。層を分けるだけ。
- flaky のリトライ導入。テストの規律（0046）を変えない。

## Log

- 2026-11-07: 作成（実測は work/research/commit-hook-optimization.md）。
