# 0231: Trail の GraphQL と Sidebar（Task 置換）

status: open
priority: now
design: agreed
design-ref: D104 / work/research/trail-model-v1.md §6.2
depends-on: 0230
touches: packages/core/src/graphql/entities.ts, packages/core/src/graphql/registry.ts, packages/core/src/graphql/index.ts, packages/core/src/graphql/spec.ts, packages/core/src/graphql/index.test.ts, packages/server/src/graphql/views.ts, packages/server/src/graphql/resolvers.ts, packages/server/src/graphql/context.ts, packages/server/src/graphql/schema.ts, packages/server/src/graphql/mutations/trail.ts, packages/server/src/graphql/mutations/index.ts, packages/web/src/app/Sidebar.tsx, packages/web/src/app/ShellWorkspace.ts, packages/web/src/app/viewModel.ts, packages/web/src/app/Shell.tsx, packages/web/src/__generated__/, relay.config.json

## Intent

D104 で Trail が主単位になった。Task とカンバンを残すと二重 status・二重 UI になるため、Task の GraphQL 面と Sidebar を同じ波で Trail に置き換える。

## Goal

GraphQL に Trail の読み取りと createTrail / updateTrail を追加し、Task / TaskStatus を削除する。Sidebar を Needs you / Active / Observing / Closed のリストにする（カンバン列は作らない）。

## Acceptance criteria

- [ ] SDL に Trail / TrailChange / TrailSession / TrailFinding / TrailDecision / TrailGate と閉じた enum が出る
- [ ] SDL から Task / TaskStatus が消える
- [ ] Query trails / trail(id) と createTrail / updateTrail が動く
- [ ] Sidebar は Needs you / Active / Observing / Closed のリストで、カンバン列が無い
- [ ] Relay の生成物と Web の型チェックが通る
- [ ] 既存の Task 画面・参照が残っていない

## テスト条件

- C1: Given 空の DB、When createTrail、Then trail(id) で同じ内容が返る（リスク: 契約、出所: D104）
- C2: Given Trail の SDL、When schema を生成、Then Task / TaskStatus が存在しない（リスク: 旧契約の残存）
- C3: Given in_review と observing の Trail、When Sidebar を描画、Then それぞれのリストに出て、カンバン列が無い（リスク: UI 回帰）
- C4: Given Trail.changes、When query、Then base/head が返る（リスク: generator のリスト非対応）

## テスト設計

- T1: C1 / integration / GraphQL mutation + query
- T2: C2 / unit / SDL の型名
- T3: C3 / component / Sidebar のリスト
- T4: C4 / unit / spec のリストフィールド

## Notes

- いまの entity generator がリスト / union を扱えない場合、先に spec.ts を拡張する（Trail.changes など）。これが最初の実装リスク。
- Relay は生成物を手で直さず、codegen を通す。
- Sidebar は hns の原則3（Needs you → Running → Completed）に合わせる。カンバンは作らない。

## 未確定

- U-01: Task を GraphQL から消す際、既存の client fixture をどこまで残すか / 仮説: 全置換 / 影響: テスト / 責任者: user / トリガー: 実装時

## やらないこと

- Trail 詳細 / レビュー面（0232）
- 添付（0233）
- 複数人の役割（2 人目まで作らない）

## Log

- 2026-11-17: 作成（D104）。
