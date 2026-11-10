# 0185: tiers の二重実行を廃止し、シナリオを1層に固定する

status: done
priority: now
depends-on: 0183
touches: packages/workspace/test/**, vitest.config.ts, docs/testing.md, docs/decisions.md, AGENTS.md

## Goal

同じシナリオを unit / integration の両方で回す *.tiers.test.ts を廃止する。シナリオは一度だけ、最も低い層で実行する。
workspace は dirfd 経路を integration で1回、daemon は別スモークにする。

## Acceptance criteria

- [x] *.tiers.test.ts / inject("tier") / targetsForTier を削除する
- [x] workspace の共通シナリオを test/integration に移し、dirfd ターゲットで1回だけ実行する
- [x] local daemon は別のスモークテストに分ける（全シナリオを二重に回さない）
- [x] vitest.config.ts から tiers の include / provide を削除する
- [x] docs/testing.md と 0170 の記述を更新し、D058 を追記する
- [x] npm test -w @hns/workspace と npm run check が通る

## Notes

- 対象: workspace.tiers.test.ts（318行）、hardening.tiers.test.ts（259行）。
- dirfd 前提の1件は skipIf を外し、integration で常に実行する。
- checks モード（in-process）の重複は落とす。dirfd の保護は integration で確認する。
- 削除ではなく「1回に減らす」が目的。dirfd のカバレッジは落とさない。
- 0184 の前に行い、削除・統合するテストを assertion 移行の対象にしない。

## やらないこと

- 振る舞いの変更
- workspace 以外のテストの移動（0186）

## Log

- 2026-11-10: 作成（user）。tiers の両流しはやりすぎとして廃止を決定。
- 2026-11-10: `targetsForTier` / `inject("tier")` を削除。`workspace.tiers.test.ts` と `hardening.tiers.test.ts` を `test/integration/{workspace,hardening}.test.ts` に移し、`node/dirfd` の1ターゲットに固定。
- 2026-11-10: local daemon は `test/integration/local-daemon.test.ts` のスモーク1本に分離。`toctou.test.ts` も node/dirfd の1ターゲットにした。
- 2026-11-10: `npm test -w @hns/workspace` 成功（40 tests）。`npm run check` 成功（224 passed）。
- 2026-11-10: reviewer-0185b が **PASS**（blocking なし）。review は静的な確認で、テスト再実行は author の結果を参照。

## Result

- verdict: **PASS**（reviewer-0185b。blocking なし）
- reviewer: reviewer-0185b
- HEAD: 3c09f8a + 0185 の未コミット変更
- blocking findings: なし
- 未確認: `npm run check` は author 実行（224 passed）。移動前後の byte-level diff は未確認。
- 変更は未コミット（コミットはユーザーの指示で行う）。
