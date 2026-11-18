# 0272n: 実装済みで起動しない 3 面を起動する（mirror transport・TrailChange writer・observe の配線）

status: in-progress
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

- [x] Worker → machine の mirror transport があり、**checkpoint の ack を待たせずに** push する（失敗しても ack は成功）
- [x] checkpoint が成功した run の head commit が **TrailChange として 1 行**書かれる（Trail に紐づく run だけ）
- [x] edge が Workspace に obs を渡し、**`/api/metrics` に `artifacts.mirror` が出る**
- [x] 3 つとも実経路（実 DO / 実 D1 / 実 machine）で 1 本
- [x] **実装した / 起動するの 1 表**を `packages/server/README.md` と `packages/machine/README.md` に更新

## Log

- 2026-11-18: 0246 / 0248 / 0249 の Result が同じ形の「呼ぶ者が居ない」を 3 回書いたので、まとめて 1 本にした。設計は lead。

## Result

- verdict: **PASS**（reviewer-0272n。blocking 0。中の 3 件と低 3 件は統合前に修正）
- HEAD: fff6770（main に ff 統合）。gate は exit 0（1800 tests / 1801、main で 159.3s）。
- **1（mirror transport）**: `MachineFiles.mirror?` を `createSignedMachineFiles` が実装。**token は署名済み body のみ**（ヘッダ・ログ・イベントに無い）。Workspace は **`complete` の ack を作った後**に `waitUntil` で machine へ送り、**ack は push を待たない**。失敗（transport / refusal / target 不発行 / reporter）は **ack を壊さない**。
- **2（TrailChange writer）**: **`trail_sessions` の link がある Trail にだけ** head commit を 1 行。**link が無ければ何も書かない**（勝手に Trail を作らない）。head が同 commit なら**冪等**。失敗はログのみ。
- **3（obs）**: Durable Object が**自分の binding から** sink を構築（`SESSION` / `DB` / `WORKSPACE`）。edge の start-up pass は **isolate ごとに 1 回・応答の後**（`WeakSet` + project の `WeakMap` memo）。**`/api/metrics` に `artifacts.mirror` が出る**。**sink が無いときの console** は維持。
- **実経路**: 実 `@hns/machine` / 実 Workspace DO / 実 git（https remote）/ 本物の store repo / 本物の `trailLookupFor` / 製品の `Session` の `/rpc/events` を 1 本で通す。**ack は push を保留したまま返り、release で machine が push → read-back で `mirrored` → Trail に 1 行 → `/api/metrics` に `mirror.total=1`**。
- **レビューで直したもの**: ①**起動 pass が毎リクエスト・await・全 project N fetch**（応答後に 1 回・isolate で 1 回・memo に）②`WorkspaceOptions.startup` の**死んだ抽象**を削除 ③README の `TrailChange ✓` を **✗（link が無い）**に ④`waitUntil` を**必須**に（silent に消えない）⑤`faces-start` の TSDoc が実装より強い ⑥commit message の未再現の主張。
- **実運用で起動するもの**: ①mirror の push（complete の ack 後、machine へ）②観測（`/api/metrics` の `artifacts.mirror`）。
- **実運用でまだ起動しないもの**: **`TrailChange` の writer**。**`trail_sessions` に link を書く production 経路が無い**ので、実データでは 0 行（README に ✗、BOARD に「使える」と書かない）。
- **残件（正直に）**: ①**「ack が push / TrailChange を待たない」ことはテストで十分に固定できていない**（timeout と `kept` で部分的にしか捕まらない）②「最新 link 勝ち」なので複数 session に共有された Trail は古い run の checkpoint を書けない ③Trail の最新 Change が無いと書きも進めもしない ④reporter 失敗の受け皿が未検証。
