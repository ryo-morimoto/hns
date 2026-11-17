# 0244: machine の checkpoint 操作と signed pack 転送

status: open
priority: now
design: agreed
design-ref: D106 / 0243 / docs/durability.md §5
depends-on: 0243
touches: packages/machine/src/wire.ts, packages/machine/src/operations.ts, packages/machine/src/agent.ts, packages/machine/src/wire.test.ts, packages/machine/test/integration/checkpoint.test.ts, packages/workspace/src/checkpoint.ts, packages/workspace/src/checkpoint.test.ts

## Intent

`checkpointRun` はあるが machine の操作として配線されていない。machine で checkpoint を作り、metadata と pack を分けて Worker に渡せるようにする。

## Goal

machine の closed operation に `checkpoint` を足す。応答は metadata だけ（commit / ref / packKey / objectCount / packBytes / maxBlobBytes）。pack は署名付き binary の別リクエストで送る。

## Wire 契約

- `POST /rpc/checkpoint/:runId/pack`、`Content-Type: application/x-git-pack`、`Content-Length` 必須、最大 64MiB。
- 既存の machine 署名ヘッダで認証する。署名は body を含む。
- 成功 `{ ok: true, receivedBytes }`。失敗 `{ ok: false, code: too_large | invalid_request | unauthorized }`。
- checkpoint の JSON 応答に pack bytes を含めない。
- checkpoint は git と pack で長いので、通常の operation deadline と pack upload の deadline を分ける。

## Acceptance criteria

- [ ] `checkpoint` operation（runId, committedAt?）が wire schema と `runOperation` に入る
- [ ] 応答は metadata のみ。pack は signed binary endpoint に送る
- [ ] `checkpointRun` の結果に packBytes / maxBlobBytes を足す
- [ ] 64MiB 超は送る前に too_large。部分送信しない
- [ ] 同じ runId の再実行は同じ commit を返す
- [ ] 実 git の integration test が通る

## テスト条件

- C1: Given 変更のある作業ツリー、When checkpoint、Then metadata が返り、pack が signed endpoint に届く（リスク: 配線、出所: 0154）
- C2: Given 同じ runId、When 2 回、Then 同じ commit（リスク: 二重 checkpoint）
- C3: Given 64MiB 超、When checkpoint、Then too_large で fail closed（リスク: 上限）
- C4: Given 署名なし / body 改ざん、When pack upload、Then unauthorized（リスク: 認証）

## テスト設計

- T1: C1 / integration / machine agent + 実 git + fake endpoint
- T2: C2 / integration / 再送
- T3: C3 / unit / 上限
- T4: C4 / integration / 署名

## Notes

- 受け口の実装は 0245。この issue は client と wire だけ。
- `checkpointRun` は Node の subpath export。machine でのみ動く。
- Worker の request 上限（100MB）と Artifacts の push 上限（64MiB）を混同しない。

## 未確定

- U-01: pack を 1 リクエストで送るか chunk するか / 仮説: 1 リクエスト（64MiB）/ 影響: 大きい repo / 責任者: user / トリガー: 0246

## やらないこと

- R2 への書き込み（0245）
- Artifacts への push（0246）
- UI

## Log

- 2026-11-17: 作成（D106）。
- 2026-11-17: レビュー B1 を反映（metadata と pack の分離、signed binary endpoint、deadline 分離）。
