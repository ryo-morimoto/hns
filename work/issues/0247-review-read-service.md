# 0247: オフライン review の読み取りサービス（ReviewSource + R2 fallback）

status: done
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

- [x] `reviewDiff(base, head)` が file list / 追加削除 / hunk を返す
- [x] `R2ReviewSource` が `OBJECTS` の pack / object から commit / tree / blob を読む
- [x] source の失敗は `REVIEW_FAILURES` で返し、黙って空にしない
- [x] machine への RPC を一切呼ばない
- [x] GraphQL / UI は 0248 に渡す（この issue は server service のみ）

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

## Result

- verdict: **PASS**（reviewer-0247。blocking 0 / 低 5）
- HEAD: dcb6cf8（main に ff 統合）。gate は exit 0（1145 tests / 1146、main で 61.3s）。
- 確認: `@hns/workspace/pack`（v2 header、ofs/ref delta、**object id の再計算**、trailer SHA-1、1 entry 1 inflate、64 MiB / 2^20 objects / delta 深さ 50、truncated / padded / count=0 を拒否）。**性能は 10,000 entry 298ms / 48 MiB blob 137ms**。`node:zlib` は `dist/pack.js` のみ（root entry と worker bundle に無い）。`R2ReviewSource`（`checkpoints/<commit>.pack`、40 hex、パス脱出の拒否、`not_found` / `unavailable` / `too_large` の写像）。`reviewDiff` は全か無か、`entryKind` は **`ReviewTreeEntry.mode`**（0247 で契約に追加）から。実 git の closure pack で **byte 一致**・`ls-tree` / `rev-parse` と一致・実 symlink が `symlink`・binary は hunk なし・pack 不在は `not_found`。workerd（cf dev）で `openPack` が動き、**壊した pack.ts で再ビルドすると落ちる**。mutation 2 件。
- 非 blocking（低 5）: **memory 増幅の未計測**（60×64 MiB の zero blob で RSS 4.1 GB。`maxObjectBytes` を 0248 の配線で入れる）/ `too_large` で diff 全体が空になる / knip の `ignoreIssues: src/review/*.ts` は現状 no-op / `ReviewFailure.unavailable` の TSDoc の文言 / `pack.ts` の TSDoc の「SHA-1 を再計算」の表現。
- インシデント: 一時 git fixture が commit hook の `GIT_*` で本 worktree に commit した（3 回、`reset --hard` で復旧）。**両 fixture に `fixtureEnv` を入れて再発防止**。main の `.git/config`（`core.bare`）は健全。
