# 0002: T-03/T-04 Mutation の故障注入

status: open
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