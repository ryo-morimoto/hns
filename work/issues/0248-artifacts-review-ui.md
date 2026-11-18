# 0248: Artifacts の review 読み取りと Trail UI の接続

status: open
priority: now
design: agreed
design-ref: lead 裁定 / D106 / 0246 / 0247 / 0232
depends-on: 0246, 0247, 0232
touches: packages/server/src/review/artifacts.ts, packages/server/src/review/artifacts.test.ts, packages/server/src/graphql/resolvers.ts, packages/web/src/app/TrailDetail.tsx, packages/web/src/__generated__/, packages/web/src/app/TrailDetail.test.tsx

## 設計（lead）

- **source の選択は server 側**（`review/source.ts` の既存の `ReviewSource` を、**Artifacts があれば Artifacts、無ければ R2、どちらも読めなければ machine** の順に選ぶ）。UI に binding を漏らさない。
- **mirror の状態と source を同じ応答に載せる**（`TrailChange.diff` の隣に「どこの pack を読んだか」と「mirror が skipped / failed なら machine で見る」）。**無言で別の source に切り替えない**。
- **`ArtifactsReviewSource` は `ReviewSource`（commit id）にだけ従う**。**独自 ref に依存しない**。`REVIEW_FAILURES` の閉じた union に写す（0247 の `not_found` / `unavailable` / `too_large` / `invalid_request`）。
- **0247 の `R2ReviewSource` を置き換えない**（両方を持つ。Artifacts が無い環境は R2 だけ）。

## Intent

Artifacts の binding で C を読み、machine がオフラインでも Trail のレビュー面を出す。fallback（R2 / machine）との状態を明示する。

## Goal

`ArtifactsReviewSource` を追加し、Trail 詳細（0232）の diff / file 表示をこの source で動かす。mirror が skipped / failed の run は fallback 表示にする。

## Acceptance criteria

- [ ] `ArtifactsReviewSource` が binding の log / readTree / readFile を `ReviewSource` に合わせる
- [ ] Trail 詳細で base / head の diff が machine オフラインでも出る
- [ ] mirror が skipped / failed の run は「machine で見る」fallback を明示する
- [ ] commit は id で読み、独自 ref に依存しない
- [ ] GraphQL の resolver / schema はこの issue が唯一の所有者（0247 は触らない）
- [ ] Relay / 型チェック / component test が通る

## テスト条件

- C1: Given machine オフライン、When Trail 詳細、Then diff が出る（リスク: 読み取り）
- C2: Given mirror skipped、When 表示、Then fallback が出る（リスク: 無言の失敗）
- C3: Given commit id、When readTree / readFile、Then 内容が一致（リスク: ref 解決）

## テスト設計

- T1: C1 / component / fake source
- T2: C2 / component / state
- T3: C3 / unit / binding adapter

## Notes

- 0232（レビュー面）の後に接続する。
- source の選択は server 側で行い、UI に binding を漏らさない。
- 失敗時は machine fallback。Artifacts が落ちても review を完全には止めない。

## 未確定

- U-01: fallback を自動で選ぶか、ユーザーが切り替えるか / 仮説: 自動 + 状態表示 / トリガー: 0232 の設計

## やらないこと

- Artifacts の書き込み
- metric / feedback の添付

## Log

- 2026-11-17: 作成（D106）。design pending（0232 の UI 設計待ち）。
