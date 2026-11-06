# 0002: T-03/T-04 Mutation の故障注入

status: done
depends-on: 0001
touches: work/poc/, docs/design

## Goal

契約 v0.1 `書き込み手順 を実装し、競合とクラッシュで「静かに壊れない」ことを示す。

## Acceptance criteria

- [ ] 2クライアントが同じ版から書く → 片方 `applied`、片方 `conflict`（T-03）
- [ ] intent 後 / rename 前 / outcome 前に停止 → 表どおり applied / conflict / unknown（T-04）
- [ ] 同じ `operationId` の再送で二重適用しない
- [ ] 失更新の再現（`work/poc/mutation-gap`）が `conflict` になる

## Log

- 2026-11-06: 作成。
- 2026-11-06: `work/poc/workspace-core` を実装。40/40 合格（Node / pi-env daemon）。

## Result

- `Workspace.write` が expectedVersion を比較し、intent → temp + flush → 再確認 → rename → outcome の順で適用。
- `recover()` が intent だけ残った操作を applied / pending / unknown に分類。再送は記録済みの結果を返す。
- 残り: Journal の原子化、temp の置き場所、ディレクトリ fsync、create-if-absent、パッチ（docs/workspace.md の限界）。