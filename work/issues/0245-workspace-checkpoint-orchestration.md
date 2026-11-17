# 0245: Workspace DO の checkpoint 調停・R2・mirror 記録

status: open
priority: now
design: agreed
design-ref: D106 / 0243 / 0244 / docs/durability.md §5
depends-on: 0244
touches: packages/server/src/do/workspace.ts, packages/server/src/do/workspace.test.ts, packages/server/src/edge/handler.ts, packages/server/src/checkpoint/transport.ts, packages/server/test/integration/workspace-do.test.ts

## Intent

Run の終わりに machine の checkpoint を呼び、pack を R2 に確定させ、Journal の watermark を進める。Artifacts ミラーはこの記録の上に載せる。

## Goal

Workspace DO に checkpoint の prepare / pack / complete を足す。pack は signed binary で受け、R2 の `checkpoints/<commit>.pack` に書く。完了時に CheckpointRecord（mirror: pending, packBytes, maxBlobBytes）と watermark を保存する。

## 手順

1. `POST /rpc/checkpoint/prepare`: machine の `checkpoint` を呼び、metadata を得る。
2. `POST /rpc/checkpoint/:runId/pack`: signed binary を受け、R2 に書く（既存 key は no-op）。
3. `POST /rpc/checkpoint/complete`: watermark を書き、Journal を切り詰め、CheckpointRecord を保存する（mirror: pending）。

## Acceptance criteria

- [ ] prepare が machine の checkpoint を呼び、pack なしの metadata を返す
- [ ] pack endpoint が署名・Content-Length・64MiB を検証し、R2 に書く
- [ ] 同じ runId / commit の再送は同じ packKey を返し、二重 put しない
- [ ] complete が watermark と CheckpointRecord を1トランザクションで書く
- [ ] mirror は pending のまま。失敗しても checkpoint の ack を壊さない
- [ ] machine の checkpoint 失敗は CheckpointFailure で返し、ack しない

## テスト条件

- C1: Given Run 終了、When prepare → pack → complete、Then R2 に pack があり watermark が進む（リスク: 耐久、出所: durability §5）
- C2: Given 既存 packKey、When 再送、Then put 回数が増えない（リスク: 課金・冪等）
- C3: Given 署名なし / 64MiB 超、When pack、Then ack せず拒否（リスク: 不正・上限）
- C4: Given complete の途中失敗、When 再送、Then 同じ結果に収束（リスク: 部分成功）

## テスト設計

- T1: C1 / integration / Workspace DO + fake R2 + fake machine
- T2: C2 / unit / put 回数
- T3: C3 / unit / auth + limit
- T4: C4 / integration / 故障注入

## Notes

- R2 の key は 0153 の `checkpointPackKey` を再利用。
- ack の順序は R2 → DO（INV-10）。mirror は complete の後に非同期。
- Artifacts の token / push は 0246。ここでは mirror の状態だけ持つ。
- `CheckpointPackTransport` は 0243 の port を使い、HTTP の詳細を DO に漏らさない。

## 未確定

- U-01: checkpoint の契機（Run 終了 / 中断 / lease 解放 / SIGTERM）をどこが呼ぶか / 仮説: Session DO / Workspace DO を 0162 / 0167 に合わせる / 影響: RPO / 責任者: user / トリガー: 実装前

## やらないこと

- Artifacts への push（0246）
- restore（0155）
- UI

## Log

- 2026-11-17: 作成（D106）。
- 2026-11-17: レビュー B1/B5/B6 を反映（pack 受け口・packBytes/maxBlobBytes・mirror pending・ack 順序）。
