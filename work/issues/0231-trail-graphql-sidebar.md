# 0231: Trail の GraphQL と Sidebar（Task 置換）

status: in-progress
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

- [x] SDL に Trail / TrailChange / TrailSession / TrailFinding / TrailDecision / TrailGate と閉じた enum が出る
- [x] SDL から Task / TaskStatus が消える
- [x] Query trails / trail(id) と createTrail / updateTrail が動く
- [x] Sidebar は Needs you / Active / Observing / Closed のリストで、カンバン列が無い
- [x] Relay の生成物と Web の型チェックが通る
- [x] 既存の Task 画面・参照が残っていない

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

## Result

- verdict: **PASS**（reviewer-0231。blocking 0 / 低 7。低 2 件と契約の追記を統合前に修正）
- HEAD: 9c0e11d（main に ff 統合）。gate は exit 0（1703 tests / 1704、main で 155.3s）。
- **SDL から Task / TaskStatus が消えた**（golden・web の schema・生成物・web のソースの 4 か所で確認）。**Trail 系 6 型 + 閉じた enum 10 種**が出る。
- **面**: `Query.trails(projectId?, first?)` / `trail(id)` / `createTrail` / `updateTrail`。`trail(id)` は **global id のみ**を受け、**無い行は `not_found`**（空 payload にしない——「削除」と「読み込み中」を区別するため）、**読めない行は `UNAVAILABLE`**。`createTrail` は **state を入力に取らない**（D104）、**作成者は session subject**。`QueryFailure` に `not_found` を追加（**他の Query は返さない**、web の生成 enum の差分は 1 値）。
- **Sidebar** は Needs you（in_review）/ Active（draft, active）/ Observing（merged, observing）/ Closed（closed, abandoned）の **4 リスト**で、**カンバン列が無い**（`role=group` 4 つ、`listbox` / `grid` / `column` 不在）。
- **実経路**: 実 SQLite + migration 0010 + 本番 `createGraphQLFace` + 本物の store で create → trail(id) の往復、project の絞り込み、`Trail.changes` の base/head、Sidebar と trail(id) の一致、**web の compiled operation が `tasks` を含まない**。**corrupt 行は `UNAVAILABLE`**（実 D1）。mutation 3 件 + 追加 1 件を検出。
- **レビューで直したもの**: ①graphql 層が store の `ValiError` を `instanceof` で握っていた（**`listChanges` を他の読みと同じ `corrupt_row` の値に揃え、server から `valibot` の import を消した**。0230 の Result に書いた「唯一の throw 経路」をここで閉じた）②存在しない 0149 を指す TSDoc ③`docs/contracts/graphql.md` に Trail の面を追記。
- **残件**: (1) **Change 行を budget に積んでいない**（`listChanges` に LIMIT が無く、行数は読んだ後でしか分からない。件数ぶん積んでページを返すのは follow-up）。(2) **Trail から `sessions` / `findings` / `decisions` / `gates` を辿る field は無い**（0232 以降。今は型として SDL に出るだけ）。(3) `overrides as Map<...>` の SAFETY 1 箇所（core の root factory 契約を MutableMap に変えるかは設計判断）。(4) **`createTrail` / `updateTrail` を呼ぶ UI はまだ無い**（0232 で詳細・レビュー面が付くまで API だけ）。
