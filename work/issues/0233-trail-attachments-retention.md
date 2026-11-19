# 0233: Trail の添付・保持・session reveal

status: open
priority: next
design: agreed
design-ref: D104 / work/research/trail-open-questions-options.md
depends-on: 0232
touches: packages/server/src/graphql/mutations/trail.ts, packages/server/src/graphql/views.ts, packages/server/src/graphql/resolvers.ts, packages/server/src/trails/retention.ts, packages/server/src/trails/reveal.ts, packages/web/src/app/TrailDetail.tsx, packages/web/src/__generated__/, packages/web/src/app/TrailDetail.test.tsx

## Intent

Trail を意図のアンカーにし、プロダクト FB・メトリクス・eval・note を後から attach できるようにする。session 全文は既定で出さず、必要時だけ監査付きで reveal する。保持は TTL クラスで回す。

## Goal

Feedback / Metric / Eval / Note の attach、session の reveal、retention job を実装する。Metric は相関として表示し、ゲートにしない。

## Acceptance criteria

- [ ] attachTrailFeedback / recordTrailMetric / addTrailEval / addTrailNote が動く
- [ ] Metric は definition / hypothesis / experiment_id / window を持ち、ゲート評価に使われない
- [ ] Session は既定で summary。全文は reveal（理由必須・監査・TTL 30 日）でのみ読める
- [ ] プロジェクト設定 transcript_storage: none で全文を保存しない
- [ ] retention job が TTL で payload を削除し、tombstone を残す
- [ ] attach は append-only。訂正は supersedes、外部取り込みは external_id で冪等

## テスト条件

- C1: Given 同じ external_id、When 2 回 attach、Then 1 件だけ（リスク: 冪等）
- C2: Given closed の Trail、When feedback を attach、Then 受け付ける（リスク: 遅延データ）
- C3: Given reveal、When 監査、Then actor / reason / at が残る（リスク: プライバシー）
- C4: Given TTL 経過、When retention job、Then payload が消え tombstone が残る（リスク: 削除）
- C5: Given metric が悪化、When merge、Then metric はゲートにならない（リスク: Goodhart）

## テスト設計

- T1: C1 / unit / external_id
- T2: C2 / integration / attach
- T3: C3 / unit / audit
- T4: C4 / integration / retention
- T5: C5 / unit / gate 評価

## Notes

- session 全文は R2。repo には入れない（Entire の refs 方式を採らない）。
- Metric は observed と表示し、因果は experiment_id がある時だけ。
- 自動 reopen はこの issue ではやらない（Phase 2）。

## 未確定

- U-01: reveal の対象を owner のみから approver に広げる時期 / 仮説: 2 人目以降 / 影響: 認可 / 責任者: user / トリガー: 複数人対応の issue（未作成）

## やらないこと

- 自動 reopen
- legal hold（Phase 2）
- 複数人の役割（2 人目まで作らない）

## Log

- 2026-11-17: 作成（D104）。
