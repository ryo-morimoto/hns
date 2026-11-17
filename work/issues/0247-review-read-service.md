# 0247: オフライン review の読み取りサービス（ReviewSource + R2 fallback）

status: open
priority: now
design: agreed
design-ref: D106 / 0243 / work/research/cloudflare-git-vcs.md
depends-on: 0243
touches: packages/server/src/review/service.ts, packages/server/src/review/service.test.ts, packages/server/src/review/r2.ts, packages/server/src/review/r2.test.ts

## Intent

machine がオフラインでも review できるように、base / head の commit から file list / tree / blob / diff を読むサービスを作る。storage（Artifacts / R2）には依存しない port にする。

## Goal

`ReviewSource` の上に `reviewDiff(base, head)` を作り、R2 の C から読む fallback 実装を用意する。Artifacts 実装と GraphQL は 0248。

## Acceptance criteria

- [ ] `reviewDiff(base, head)` が file list / 追加削除 / hunk を返す
- [ ] `R2ReviewSource` が `OBJECTS` の pack / object から commit / tree / blob を読む
- [ ] source の失敗は `REVIEW_FAILURES` で返し、黙って空にしない
- [ ] machine への RPC を一切呼ばない
- [ ] GraphQL / UI は 0248 に渡す（この issue は server service のみ）

## テスト条件

- C1: Given base..head、When reviewDiff、Then 変更 file と hunk（リスク: diff、出所: 0009 / 0011）
- C2: Given R2 に C の pack、When read、Then commit / tree / blob が読める（リスク: 復元）
- C3: Given source の失敗、When reviewDiff、Then REVIEW_FAILURES（リスク: 無言の空）

## テスト設計

- T1: C1 / unit / fake source
- T2: C2 / integration / R2 fake
- T3: C3 / unit / error

## Notes

- `ReviewSource` は 0243 の interface。Artifacts 実装（0248）を差し替えられる。
- diff のアルゴリズムは既存 0009 / 0011 を再利用する。
- GraphQL の形は 0248 が所有する。0231 / 0232 と衝突させないため、この issue では resolver / schema を触らない。

## 未確定

- U-01: pack を Worker で index するか、manifest を併用するか / 仮説: まず pack index / 影響: 初回の CPU / 責任者: user / トリガー: 実装時

## やらないこと

- Artifacts binding の実装（0248）
- Trail の UI（0248）

## Log

- 2026-11-17: 作成（D106）。
