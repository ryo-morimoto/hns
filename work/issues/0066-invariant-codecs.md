# 0066: 不変条件を型と codec に寄せる（IsoTimestamp / OperationId）

status: done
depends-on: 0047
touches: packages/core, packages/store, packages/workspace, packages/agent, packages/core/test, packages/workspace/test

## Goal

レビューで繰り返した「入口ごとの検証漏れ」を、型と1つの codec で塞ぐ。0047 の review で出た
非 ISO clock / setLastFiredAt と、0053 の operationId 直接呼び出しを先例にする。

## Acceptance criteria

- [x] core に `IsoTimestamp` と `OperationId` の brand、schema、constructor を置く
- [x] `IsoTimestamp` は store の clock と `setLastFiredAt` / firing の入力型に使い、非 ISO を型で作れなくする
- [x] `OperationId` は agent が返し、workspace.write の入口で parse する（HTTP 以外の直接呼び出しも拒否）
- [x] ISO の規則は core の codec 1箇所だけ。store/core の inline `v.isoTimestamp` をなくす
- [x] `packages/core/test/codecs.test.ts` が codec の境界と「規則の owner が1つ」を検証する
- [x] `npm run check` green

## Notes

- 公開 DTO の timestamp フィールドと `FileWriteRequest.operationId` はまだ `string`。codec の出力（brand）は
  string の subtype なので互換を保つ。全部を brand に広げるのは server / web が揃ってから。
- 0065 の ISO 二重定義はこの issue で解消した。残り（default clock / core comment）は 0065 のまま。

## やらないこと

- `JournalIntent.temp` の union 化（0061）。
- すべての DTO の timestamp を brand にすること。
- Error の `Result` 化（別 issue）。

## Log

- 2026-11-07: 作成。0047 の review と 0053 を先例に、IsoTimestamp / OperationId を実装。
- 2026-11-07: 独立 review（codec-review）PASS。low 5件は 0068 に切り出した。

## Result

- `packages/core/src/codecs.ts` が `IsoTimestamp` / `OperationId` の brand・schema・constructor を持つ。
  `IsoTimestampSchema` は store の row と core の wire schema で共有し、inline の ISO 規則を消した。
- store の `StoreOptions.now` / `StoreContext.now` / `setLastFiredAt` / `createFiring.at` は `IsoTimestamp`。
  非 ISO は型で入らず、JS から渡しても open / 書き込み前に拒否する。
- workspace.write は入口で `OperationId` を parse し、HTTP 以外の直接呼び出しでも不正 id を `Denied` にする。
  agent の `operationIdFor` も codec を通す。
- `packages/core/test/codecs.test.ts` が codec の受け入れ・拒否と、ISO / operationId 規則が codecs.ts 以外に
  再定義されていないことを確認する。
- tests: 173 passed。`npm run check` green（lint / fmt / tsc / test / build / knip）。
- 独立 review: **codec-review / PASS / HEAD 19ba65f**。blocking なし。low 5件は [0068](0068-codec-low-followups.md)。
