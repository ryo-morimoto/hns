# 0272n: 実装済みで起動しない 3 面を起動する（mirror transport・TrailChange writer・observe の配線）

status: open
priority: now
design: agreed
design-ref: 0246 / 0248 / 0249 の Result
depends-on: 0246, 0248, 0249
touches: packages/server/src/do/machine.ts, packages/server/src/checkpoint/face.ts, packages/server/src/edge/handler.ts, packages/server/src/do/workspace.ts, packages/server/src/do/session.ts, packages/server/src/do/machine.test.ts, packages/server/src/do/workspace.test.ts, packages/server/test/integration/checkpoint-flow.test.ts, packages/store/src/repositories/trails.ts

## Intent

0246（mirror の push）・0248（Artifacts を先に読む）・0249（観測）は main にあるが、**呼ぶ者が居ない**。
0246 / 0248 / 0249 の Result が揃って「実運用ではまだ起動しない」と書いている 3 点を閉じる。

1. **Worker → machine の `op:"mirror"` transport と、face の mirror 経路**（0246 の Result）。machine 側の `mirror` op は実装済み。
2. **Trail の `TrailChange` を書く production writer**（0232 / 0248 の Result）。今は `addChange` を呼ぶ production 経路が無いので、**Trail 詳細の diff が実データで出ない**。
3. **Workspace の `observe` sink を edge から渡す配線**（0249 の Result）。今は行が **console まで**で、`/api/metrics` には乗らない。

## 設計（lead）

- **1 は Session DO の checkpoint 完了後**（`complete` の ack の後）に、**machine へ `op:"mirror"` を 1 回**送る。**ack を待たせない**（0245 の「mirror の失敗が ack を壊さない」を守る）。結果は既存の `/rpc/checkpoint/mirror` に記録する。**transport は 0248 の `createSignedMachineFiles` の署名を流用**。
- **2 は checkpoint が成功したら**、**run の head commit を TrailChange に書く**（run に Trail が紐づくなら）。**紐づかない run では書かない**（勝手に Trail を作らない）。
- **3 は edge の `Worker` が Workspace DO に obs を渡す**（Session DO の obs と同じ factory）。**sink が無いときの console は残す**（0249 の fallback を壊さない）。
- **3 つとも、失敗は「checkpoint / Trail / 応答」を壊さない**（観測と mirror は best effort、TrailChange は checkpoint の成功に従属）。

## Acceptance

- [ ] Worker → machine の mirror transport があり、**checkpoint の ack を待たせずに** push する（失敗しても ack は成功）
- [ ] checkpoint が成功した run の head commit が **TrailChange として 1 行**書かれる（Trail に紐づく run だけ）
- [ ] edge が Workspace に obs を渡し、**`/api/metrics` に `artifacts.mirror` が出る**
- [ ] 3 つとも実経路（実 DO / 実 D1 / 実 machine）で 1 本
- [ ] **実装した / 起動するの 1 表**を `packages/server/README.md` と `packages/machine/README.md` に更新

## Log

- 2026-11-18: 0246 / 0248 / 0249 の Result が同じ形の「呼ぶ者が居ない」を 3 回書いたので、まとめて 1 本にした。設計は lead。
