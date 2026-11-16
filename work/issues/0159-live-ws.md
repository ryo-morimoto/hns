# 0159: ライブ更新の WS 化（SSE の置き換え）

status: open
priority: now
design: agreed
design-ref: D047
depends-on: 0146
touches: packages/server/src/ws.ts, packages/server/src/ws.test.ts, packages/server/src/do/session.ts, packages/server/src/do/state.ts, packages/server/src/do/session-rpc.test.ts, packages/server/src/do/session.test.ts, packages/server/test/support/live.ts, packages/server/src/edge/problem.ts, packages/server/test/integration/session-do.test.ts, packages/core/src/stream.ts, packages/core/src/stream.test.ts, packages/agent/src/session.ts, packages/agent/src/session.test.ts, packages/web/src/live/, packages/web/src/app/, packages/web/test/live/, packages/server/README.md, work/issues/0159-live-ws.md

## Goal

会話のライブ更新を Session DO の WebSocket に寄せる。0050 と 0118 をこの形で置き換える。

## Acceptance criteria

- [ ] WS のメッセージ型を core に置き、閉じた union にする
- [ ] 再接続で取りこぼさない（snapshot → 差分の順、cursor 付き）
- [ ] hibernation 中でもメッセージが届く（`acceptWebSocket`）
- [ ] token の delta は間引いて送る（フレーム数の上限をテストで固定）
- [ ] 切断中の状態を UI が説明できる

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 未知の type / protocol / 余分な形の frame → 受信 → 型付き失敗。snapshot / append / delta / pong / error だけが通る | 中 | 受入「閉じた union」 |
| C2 | 会話を購読 → 接続 → 最初の frame が cursor 付き snapshot で、その後の差分より先に届く | 高 | 受入「snapshot → 差分」 |
| C3 | 接続中に切断 → その間に entry が増える → 再接続 → snapshot に切断中の entry が入り、取りこぼさない | 高 | 受入「再接続で取りこぼさない」 |
| C4 | hibernation 可能な socket を accept → attachment に購読と cursor を保存 → DO を起こし直す → 既存 socket が再購読し snapshot を送る | 高 | 受入「acceptWebSocket」 |
| C5 | token delta を 10ms 間隔で 1 秒、または 64KiB 超を一気に流す → 送信 → frame は 100ms あたり 1 以下、1 frame は 64KiB 以下 | 高 | 受入「delta を間引く」/ 0046 Notes |
| C6 | 接続が切れる → 再接続中は試行回数と説明、上限超過は未接続と再読み込みの説明を UI が出す。再接続 URL は最後の cursor を持つ | 中 | 受入「切断中の状態を UI が説明」 |
| C7 | conversationId 欠落 / 不正 → upgrade 前の 400、存在しない ID → 404。ping → pong、未知の client message → error で socket は開いたまま | 中 | 失敗経路 |
| C8 | socket を閉じる → 購読が止まり、以後の view 更新を送らない | 中 | 資源リーク |
| C9 | 変更後の tree → `npm run check` → exit 0 | 中 | 完了条件 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| C1 | 閉じた union | 契約・同値分割 | unit | `packages/core/src/stream.test.ts` |
| C2 | snapshot → 差分の順 | 状態遷移 | unit | `packages/server/src/ws.test.ts` |
| C3 | 切断中の欠落なし | 故障注入 | unit + integration | `packages/server/src/ws.test.ts`（偽 socket）、`packages/server/test/integration/session-do.test.ts`（実 WS） |
| C4 | acceptWebSocket / attachment / 再購読 | 状態遷移 | unit | `packages/server/src/ws.test.ts` + fake DO state |
| C5 | frame 数と大きさの上限 | 境界値分析 | unit | `packages/core/src/stream.test.ts` |
| C6 | 再接続と状態説明 | 状態遷移 | unit（jsdom） | `packages/web/src/live/*.test.ts`、`packages/web/src/app/LiveConnection.test.tsx` |
| C7 | 不正入力・未知 message | 同値分割 | unit | `packages/server/src/ws.test.ts` |
| C8 | close で購読解除 | 状態遷移 | unit | `packages/server/src/ws.test.ts` |
| C9 | ゲート | — | static | `npm run check` |

- 実 hibernation（eviction 後の wake）は cf dev が再現しないため、C4 は fake DO state で accept / attachment / 再購読を証明し、実経路は「実 WebSocket upgrade と socket 越しの snapshot / append」までとする。未確認は Result に残す。
- token delta の実供給は faux の progress commit（`pi.live`）を ConversationView watch で受ける。間引きの上限は純関数（TokenBatcher）で固定する。

## Notes

- PoC はポーリング（run.mjs）。WS は未実装。
- フレーム数を増やすと DO のリクエスト課金とレイテンシの両方に効く。100ms か 64KB でまとめる。

## やらないこと

- SSE の併存。移行が済んだら消す。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。- 2026-11-17: ユーザーの判断で `plan` から `now` へ昇格。レーン L2。3本が空くまで待機し、`do/session.ts` と `web/src/app/` を touches に足した。
- 2026-11-17: 実装開始。token delta の実経路のため `packages/agent/src/session.ts`（ConversationView watch）と `do/state.ts`、ws / stream のテストを touches に追加（lead へ報告）。edge の転送は既存のまま 101 を通す想定で触らない。
