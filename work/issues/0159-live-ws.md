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

- [x] WS のメッセージ型を core に置き、閉じた union にする
- [x] 再接続で取りこぼさない（snapshot → 差分の順、cursor 付き）
- [x] hibernation 中でもメッセージが届く（`acceptWebSocket`）
- [x] token の delta は間引いて送る（フレーム数の上限をテストで固定）
- [x] 切断中の状態を UI が説明できる

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

- PoC はポーリング（run.mjs）。製品の WS はこの issue。
- フレーム数を増やすと DO のリクエスト課金とレイテンシの両方に効く。100ms か 64KB でまとめる。

## やらないこと

- SSE の併存。移行が済んだら消す。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。- 2026-11-17: ユーザーの判断で `plan` から `now` へ昇格。レーン L2。3本が空くまで待機し、`do/session.ts` と `web/src/app/` を touches に足した。
- 2026-11-17: 実装開始。token delta の実経路のため `packages/agent/src/session.ts`（ConversationView watch）と `do/state.ts`、ws / stream のテストを touches に追加（lead へ報告）。edge の転送は既存のまま 101 を通す想定で触らない。
- 2026-11-17: 実装（c3c4116）。`core/src/stream.ts` の `LiveFrame` union と `LiveDeltaBatcher`、`server/src/ws.ts` の `acceptWebSocket` + attachment、`do/session.ts` の再購読、agent の `watchConversation`、web の再接続 client と `LiveConnection`。SSE は製品コードに未実装だったため削除対象は無い（0050 / 0118 は superseded のまま）。
- 2026-11-17: cf dev に production edge 経由の実 WS を追加（署名 cookie を test Worker が注入）。test Worker の DO 名を edge と同じ `default` に揃え、edge → Session DO の 101 転送を実経路で確認。

## Result

- 実装: c3c4116（branch `issue/0159-live-ws`）。status は open のまま（独立レビュー前）。
- ゲート: `npm run check` exit 0。310 tests / 59 files、lint / fmt / typecheck / build / deploy dry-run / knip すべて ok。
- 受入の証拠:
  - 閉じた union: static な `LIVE_FRAME_TYPES` / valibot variant と `core/src/stream.test.ts`（未知 type・別 protocol は拒否）。
  - snapshot → 差分 + cursor: `server/src/ws.ts` が接続ごとに snapshot を先に送り、以後 append / delta。`server/src/ws.test.ts` と cf dev の実 WebSocket（`server/test/integration/session-do.test.ts`）で、接続 → snapshot → send → append、切断中の send → 再接続 snapshot を確認。production edge の `/ws` についても、署名 cookie を注入した test Worker から実 upgrade → 101 → snapshot を確認。
  - `acceptWebSocket`: `do/session.ts` が socket を tag 付きで accept し、attachment（conversationId / cursor）から wake 後に再購読。fake DO state の `server/src/do/session.test.ts` で、再生成後の snapshot / ping / close を確認。
  - delta 間引き: `core/src/stream.ts` の `LiveDeltaBatcher` が 100ms または 64KiB でまとめ、frame は 64KiB 以下。`stream.test.ts` が 1 秒の frame 上限と 64KiB 分割を固定。`ws.test.ts` が replace の chunk を確認。
  - UI の切断説明: `web/src/live/state.ts` の `explainConnection` と `web/src/app/LiveConnection.tsx`。jsdom の `client.test.ts` / `state.test.ts` / `LiveConnection.test.tsx` が再接続 cursor・試行回数・offline の説明を確認。画面への mount は 0105。
- 実経路で確認したこと: cf dev の test Worker → Session DO で実 WebSocket upgrade / 101、snapshot、ping → pong、send 後の append、切断中の send、再接続 snapshot。production edge 経由でも、署名 cookie を注入した upgrade が 101 になり snapshot が届くこと（edge → Session DO の転送）を確認。
- 未確認 / reviewer 向け: 実 eviction（75 秒 hibernation 後の wake）は cf dev が evict しないため再現しておらず、C4 は fake DO state の accept / attachment / 再購読まで。実 provider の token 速度は 0152。reviewer は未割当。
