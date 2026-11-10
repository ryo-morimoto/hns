# 0170: integration 層を分ける

status: done
depends-on: -
touches: packages/*/test/**, vitest.config.ts, packages/*/package.json, docs/testing.md, AGENTS.md

## Goal

「遅いから」ではなく「**1プロセスで終わらない**」を基準にテストを integration へ分ける。
遅い unit テストは層ではなくテストの書き方の問題として扱い、ここには混ぜない（0172）。

## Acceptance criteria

- [x] 基準を [docs/testing.md](../docs/testing.md) に書く（プロセスを要するものだけ）
- [x] workspace の daemon / dirfd 系を `test/integration` へ（`*.tiers.test.ts` を両層で回す）
- [x] sandbox（bwrap）のテストを integration へ
- [x] agent の bash 実行テストを integration へ
- [x] vitest を `<pkg>` / `<pkg>-integration` の2プロジェクトに分ける
- [x] `npm test -w @hns/<pkg>` は両方を回す（`--project '<pkg>*'`）
- [x] pre-commit は unit のみ、pre-push は全部

## Notes

- 実測: workspace unit 771ms（20 passed / 1 skipped）、workspace integration 12.5s。
  agent unit 595ms（変更前 3.7s、detectSandbox をファイル単位でキャッシュ）、agent integration 461ms。
- 両層で回すシナリオは `*.tiers.test.ts` に置き、`inject("tier")` で対象を選ぶ。
  モジュールを import してテストを登録する方式は、Vitest がファイル単位でテストを集めるため使えない（実測）。
- unit は `rooted: false`（checks モード）で走らせる。dirfd の保護は integration 側で確かめる。
- dirfd でしか成り立たない1件（親の差し替え）は `test.skipIf(!testTarget.rooted)` にした。

## Result

- verdict: **PASS**（初回 FAIL。root trigger のコミットで integration が pre-commit に流れた → 段階表に `tier` を足して修正）
- reviewer: tier-reviewer
- HEAD: d40ac8f
- blocking findings: なし（修正後に再レビュー PASS）
- 追記（2026-11-10）: `*.tiers.test.ts` の二重実行は 0185 で廃止した。層の基準（1プロセスで終わるか）と unit / integration の分離は維持する。
