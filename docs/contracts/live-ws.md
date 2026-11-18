# 契約: 会話のライブ更新と chat の送信（WS）

2026-11-18 / D047（0159 で SSE を置き換え）、D077（送信は WS のメッセージ）。**この面の契約の正本**。実装は `@hns/core` の `stream`、`server/src/ws.ts`、`do/session.ts`（`#chatPort`）、web の `live/` と conversation 画面。会話の行と state は [conversation](conversation.md)、失敗の語彙は [failures](failures.md)、認証は [auth](auth.md)。

## 1 本の socket、1 つの会話

- `GET /ws?conversationId=<id>`（**session 認証**、upgrade のとき）は 1 会話を購読する。edge は `project` で Session Object を選ぶ（D080）。未知の会話は upgrade の前に `404`。
- **1 回の会話訪問は 1 本の socket**。画面が自分のために 2 本目を開かない（route が 1 つの client を持ち、画面に渡す）。1 会話に 2 つの購読者がいる前提は無い。
- 切断・再接続では **snapshot → 差分**。クライアントは最後の `cursor` を送り、サーバは接続ごとに snapshot を送る（cursor は相関用で、取りこぼしを差分で埋めるのはサーバ）。
- eviction（hibernation）後は同じ socket を attachment（`conversationId` / `cursor`）から張り直す。**張り直した連接も chat の経路を持つ**（`chat` の無い連接は send をすべて `unavailable` にする）。

## メッセージ（閉じた union）

語彙は `@hns/core` の `LIVE_CLIENT_MESSAGE_TYPES` / `LIVE_FRAME_TYPES` / `LIVE_SEND_RESULTS`。意味だけを書く。

- **client → server**: `ping`（`pong` が返る）、`resync`（最新 snapshot の再送）、`send`（`{conversationId, clientMessageId, text}`）、`abort`（`{conversationId}`）。
- **server → client（会話の view）**: `snapshot` / `append` / `delta` / `pong` / `error`。`delta` は in-flight の回答で、cursor を進めない。
- **server → client（送信の答え）**: `accepted`（`{clientMessageId, messageId}`）または `rejected`（`{clientMessageId, code, message}`）。**視点の frame とは別の union**で、同じ socket に載る。判別はスキーマ（`sendResultOf`）で、読み手の `typeof` では無い。

## 送信（D077）

- 送信は **WS の `send` だけ**。REST POST を作らない。
- **`clientMessageId` が同じなら同じ turn**。client は未応答の send を保持し、再接続で同じ id を再送する。server の連接は同じ id の pending を待たせて 1 回だけ実行する。object は `clientMessageId` を turn の `requestId` として route に渡す。
- 送信は object の**自分の turn route**（`POST /rpc/conversations/<id>/messages`）を通す。よって認可・cost gate・policy snapshot・grant path は Worker からの送信と同じ 1 本で、**cost gate を通るのは 1 回**。
- 空 text・64KiB（UTF-8）超・`conversationId` / `clientMessageId` の欠落は **`invalid_request` の error frame**で、turn は始まらない。未知の会話は `rejected: unknown_conversation`。
- 失敗（object の不達・turn を記録できなかった）は `rejected: unavailable`。**client はこれを再送しない**（切断で終わった send だけを再送する）。

## 停止（abort）

- 停止は `abort` の frame。object は `POST /rpc/conversations/<id>/abort` を呼ぶ（0159 / 0146 の既存 route）。
- abort 自体は frame を返さない。run が終わったことは **view**（中断された assistant entry）で届く。拒否（未知の会話）は `error` frame。

## 変わったとき

- frame の語彙・形を変える: `core/src/stream.ts` とそのテスト・`server/src/ws.ts`・web の `live/client.ts` とこのファイルを同じ変更で。
- 「1 訪問 1 socket」を変える: conversation 画面の route と、その socket 数のテスト（`conversation.test.tsx`）を同じ変更で。
