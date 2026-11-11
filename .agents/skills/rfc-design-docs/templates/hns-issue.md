# NNNN: <title>

status: open
priority: plan
depends-on: —
touches: <paths>

<!-- now / hold は人間が決める。agent は plan のまま作る（work/README.md）。 -->

## Goal

<!-- 何を達成するか。測定可能な goal / success criteria。solution の説明にしない。 -->

## Acceptance criteria

- [ ] <検証できる形>

## テスト条件

- C1: Given / When / Then（リスク、出所）

## テスト設計

- T1: 条件 / 技法 / 層 / テスト

## Problem / context

<!-- 誰のどんな問題か。事実・再現・数値・現状の workaround。solution はまだ書かない。 -->

## Users and use cases

<!-- 代表的な user / operator / developer と scenario を 2〜3 個。今どうしているか、何が足りないか。 -->

## Non-goals

<!-- 今回はやらないこと。選ばなかった目標。 -->

## Options and trade-offs

<!-- 最低2案。do nothing も。表: option / 概要 / 利点 / 欠点 / リスク / コスト / 採用条件。 -->

| Option | Summary | Pros | Cons | Risk | Cost |
| --- | --- | --- | --- | --- | --- |
| A |  |  |  |  |  |
| B |  |  |  |  |  |
| Do nothing |  |  |  |  |  |

## Recommendation

<!-- どの案を推すか。なぜ goals に合うか。assumption。 -->

## Design: guide-level

<!-- すでに採用されたものとして、使い方を教える。用語・具体例・before/after・エラー・移行例。 -->

## Design: reference-level

<!-- 実装者が再現できる仕様。API / data / algorithm / state machine / invariant / edge case。 -->

## Invariants and failure modes

<!-- 常に成り立つこと。失敗・再送・競合・部分失敗・unknown の扱い。 -->

## Cross-cutting concerns

<!-- security / privacy / observability / operability / cost / performance / accessibility / i18n。 -->

## Compatibility, migration, rollback

<!-- 何が壊れるか。移行手順。rollback。version skew。 -->

## Test plan

<!-- unit / integration / e2e / fault injection。acceptance criteria は上、ここでは検証方法と成功 metrics。 -->

## Rollout and graduation

<!-- canary / flag / opt-in。監視と abort 条件。docs / support。次の段階の条件。 -->

## Notes

<!-- 背景、prior art、関連 issue、実装上の注意。 -->

## 未確定

- U-01: 何が / 仮説 / 影響 / 責任者 / 期限かトリガー

## やらないこと

<!-- 今回やらないことと、先回りしない将来作業。 -->

## Log

- YYYY-MM-DD: 作成

## Result

- 独立レビュー: <reviewer> / PASS / HEAD <sha>
- blocking: なし

<!--
契約の詳細（型・schema・不変条件・フロー）は docs/*.md と ARCH.md に分ける。
決定は docs/decisions.md に DNNN として追記する（templates/hns-decision.md）。
この issue には、decision に必要な設計の骨格と、検証可能な acceptance を残す。
-->
