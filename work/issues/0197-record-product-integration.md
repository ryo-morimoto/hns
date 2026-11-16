# 0197: 記録の製品統合（WorkItem / Evidence への写像）

status: open
priority: plan
depends-on: 0116, 0120, 0196
touches: packages/core/src/types.ts, packages/store/src, packages/server/src, packages/web/src

## Intent

0196 のレコード語彙を、製品の WorkItem / Evidence に写像する。製品はプロセスの記録を別に持たず、同じ判断（意図・受入基準・証拠・限界・決定・無効化）を使えるようにする。

## Goal

@hns/record の語彙を core のモデルに写像し、D1 と GraphQL に載せ、Review / Progress 画面で読めるようにする。

## Acceptance criteria

- [ ] WorkItem に done level、criteria、decisions、evidence summary が載る
- [ ] Evidence が criterion を指し、limits と invalidation を持つ
- [ ] done level は記録から導出され、手動で上げられない
- [ ] GraphQL で読み書きできる（recordCriterionResult / recordDecision / requestReview）
- [ ] Review / Progress が done level で並ぶ
- [ ] 独立レビュー PASS

## やらないこと

- OutcomeSource の実装（0198 候補）
- store / server / web から import するときは oxlint.config.ts の許可を足す
- チーム / RBAC

## Log

- 2026-11-16: 作成。0196 の後に着手する。
