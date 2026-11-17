# 0245: Workspace DO の checkpoint 調停・R2・mirror 記録

status: in-progress
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

- [x] prepare が machine の checkpoint を呼び、pack なしの metadata を返す
- [x] pack endpoint が署名・Content-Length・64MiB を検証し、R2 に書く
- [x] 同じ runId / commit の再送は同じ packKey を返し、二重 put しない
- [x] complete が watermark と CheckpointRecord を1トランザクションで書く
- [x] mirror は pending のまま。失敗しても checkpoint の ack を壊さない
- [x] machine の checkpoint 失敗は CheckpointFailure で返し、ack しない

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

## Result

- verdict: **PASS**（reviewer-0245。初回 BLOCKED 1（edge 経路のテスト不在で face のルーティングを壊しても gate が緑）→ 修正 → PASS）
- HEAD: 2fb816a（main に ff 統合）。gate は exit 0（1087 tests / 1088、main で 58.8s）。
- 確認: `prepare`（machine の checkpoint を control-plane 鍵で署名して呼ぶ）、`pack`（device 鍵を `machines.public_key` で検証・**Worker が実バイトから sha256 を計算**して署名対象の bodyHash と照合・64 MiB を本文前に拒否・key は prepare 行から）、`complete`（record と watermark を 1 トランザクション、応答喪失の再送、record 無し + watermark 済み + R2 に pack 無しは 409）。server に `node:` は 0（WebCrypto のみ）。edge は **認証 → method** の順（未認証は 401、GET は 405 + allow: POST）。createEdge を通す経路テスト 6 本と、**mutation 3 種（method 判定無効・パス改名・認証順の戻し）がすべて検出される**ことをレビュー担当が確認。実 workerd は cf dev の integration に面を通して境界（401 / 405）まで。
- 非 blocking（follow-up）: workerd の runtime pool は未導入（cf dev で代替）/ 認証済み prepare が object に届く所は workerd 未検証 / `parsePrepareRow` の v.parse は破損行で 500 / transport の at-limit テストの結び付き / pack 経路のルーティングは workerd の 405 のみ / `docs/packages.md` への export 追記（所有者待ち）。
- 申し送り: workerd で fake D1 に `schema_migrations` の版だけ返させれば認証済み prepare まで通せる見込み（migration DDL を fake で成功させない）。
