# 0248: Artifacts の review 読み取りと Trail UI の接続

status: in-progress
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

- [x] `ArtifactsReviewSource` が binding の log / readTree / readFile を `ReviewSource` に合わせる
- [x] Trail 詳細で base / head の diff が machine オフラインでも出る
- [x] mirror が skipped / failed の run は「machine で見る」fallback を明示する
- [x] commit は id で読み、独自 ref に依存しない
- [x] GraphQL の resolver / schema はこの issue が唯一の所有者（0247 は触らない）
- [x] Relay / 型チェック / component test が通る

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

## Result

- verdict: **PASS**（reviewer-0248。blocking 0 / 低 8。NB-1 を含む 4 件は統合前に修正）
- HEAD: 242a23f（main に ff 統合）。gate は exit 0（1763 tests / 1764、main で 159.4s）。
- **選択は server 側**: **Artifacts → R2 → machine** の順。**0247 の R2ReviewSource を置き換えず併存**。UI に binding は漏れない（web の import は relay-runtime のみ）。
- **無言の切り替えをしない**: R2 で読んだら **mirror の状態と fallback 文を同じ応答に**載せる。Artifacts で読めたときは mirror が空（説明すべき fallback が無い）。**machine に落ちた場合は空 diff にせず typed unavailable**（「machine は未対応」を message に）。
- **ArtifactsReviewSource**: **commit id で読み、ref を使わない**（mutation で ref: "HEAD" にしたら 5 本落ちる）。path 脱出は **binding を呼ぶ前**、binding の失敗は **REVIEW_FAILURES の閉じた union**、**binding の code を持たない throw は欠陥として伝播**（丸めない）。
- **レビューで直したもの（NB-1）**: 実 binding の形は get(name) / readTree(hash) / readFile({ref, path}) → Blob で、最初の実装は {commit, path} を受ける形だった。テストの as never がその不一致を隠していたので、**adapter を挟んで本物の形に合わせ、fake も本物の型に一致**させた（**cast 0**）。**0246 の ArtifactsBinding も本物と食い違っていた**ので env の型は本物に寄せた（**0246 の writer 側は未修正 → 0249 か 0246 の owner へ**）。
- その他の修正: record の壊れた JSON 行で 500 にしない（skip）/ 「Error でない throw」の規則を #call に 1 つ化 / docs/contracts/graphql.md に source / mirror / fallback と hunk の応答も同じ型であることを追記。
- **実運用ではまだ起動しない**（**BOARD で「使える」と書かない**）: ①mirror の記録と push の起動配線は 0249 ②machine から commit を読む経路が無い ③**TrailChange を書く production writer が無い**④Artifacts の read side は実 binding で未検証。
- **残件**: too_large は Artifacts と R2 で同じ上限として即返す（32 MiB 超の run は R2 でも落ちる）/ ARTIFACTS_MIRROR の kill switch を selector が見ていない / fallback 文は日本語固定で client は訳さない（契約に 1 行）/ record の全走査（0249 で commit 列の index）。
