# 0149: 会話・run の索引（D1）

status: open
priority: plan
depends-on: 0150
touches: packages/server/src/routes/lists.ts, packages/store/src/index/

## Goal

Session DO の中にある会話と run を、外から一覧・検索・ページングで引けるようにする。
**定義・台帳（Project / Task / Workflow / Machine）は D1 が正本**なので、投影しない（D049）。

## Acceptance criteria

- [ ] 索引の列を最小に固定（id / title / status / updatedAt / projectId / machineId）
- [ ] Session DO が commit の後に自分の行を書く。順序を決め、失敗しても再送できる
- [ ] 索引が遅れたときの表示（「更新中」）を決める
- [ ] 検索は索引の範囲だけ。会話本文の全文検索は範囲外と明記
- [ ] cursor pagination のテスト（同時更新で落ちない）
- [ ] DO から索引を作り直せる（壊れても正本は失われない）

## Notes

- 0115（overview）と 0121（検索・pagination）をこの形で置き換える。
- 「投影」ではなく「索引」。正本は DO で、D1 は引くための写し。INV-11。
- 定義系の一覧（プロジェクト一覧など）は索引ではなく D1 のテーブルを直接読む。

## やらないこと

- 会話本文の全文検索。
- 集計・分析（0162 / 0163）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
- 2026-11-07: 範囲を会話・run の索引に縮小。制御データは D1 直（D049）。
