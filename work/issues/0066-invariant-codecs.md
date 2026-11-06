# 0066: 不変条件を型と codec に寄せる（IsoTimestamp / OperationId）

status: in-progress
depends-on: 0047
touches: packages/core, packages/store, packages/workspace, packages/agent, packages/core/test, packages/workspace/test

## Goal

レビューで繰り返した「入口ごとの検証漏れ」を、型と1つの codec で塞ぐ。0047 の review で出た
非 ISO clock / setLastFiredAt と、0053 の operationId 直接呼び出しを先例にする。

## Acceptance criteria

- [ ] core に `IsoTimestamp` と `OperationId` の brand、schema、constructor を置く
- [ ] `IsoTimestamp` は store の clock と `setLastFiredAt` / firing の入力型に使い、非 ISO を型で作れなくする
- [ ] `OperationId` は agent が返し、workspace.write の入口で parse する（HTTP 以外の直接呼び出しも拒否）
- [ ] ISO の規則は core の codec 1箇所だけ。store/core の inline `v.isoTimestamp` をなくす
- [ ] `packages/core/test/codecs.test.ts` が codec の境界と「規則の owner が1つ」を検証する
- [ ] `npm run check` green

## Notes

- 公開 DTO の timestamp フィールドはまだ `string`。codec の出力（brand）は string の subtype なので互換を保つ。
  全部を brand に広げるのは、server / web が揃ってから。
- 0047 の非 blocking 0065 のうち ISO の二重定義はこの issue で解消する。

## やらないこと

- `JournalIntent.temp` の union 化（0061）。
- すべての DTO の timestamp を brand にすること。
- Error の `Result` 化（別 issue）。

## Log

- 2026-11-07: 作成。0047 の review と 0053 を先例に、IsoTimestamp / OperationId を実装。
