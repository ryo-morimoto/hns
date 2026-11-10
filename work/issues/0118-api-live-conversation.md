# 0118: SSE を conversation / overview 単位にする

> 0159（ライブ更新の WS 化）に置き換え（D047）。着手しない。

status: superseded
depends-on: 0035, 0050, 0115
touches: packages/core/src/http.ts, packages/core/src/http-schemas.ts, packages/core/test, packages/server/src, packages/server/test

## Goal

会話を開いている間はその会話の state を、ホームでは overview の変化を受ける。
root conversation 固定の /api/stream を、購読対象を選べる形にする。

## Acceptance criteria

- [ ] GET /api/stream?conversationId= で、その会話の state イベントを受ける
- [ ] overview 購読では、needs / running / completed の変化だけを受ける（全 transcript を送らない）
- [ ] event は型付き（state / overview / heartbeat / error）。Last-Event-ID か cursor で再接続
- [ ] クライアントごとに購読対象を分離。root 以外の会話でも進捗が届く
- [ ] 切断・再接続・複数タブのテスト。cookie 認証で、token を URL に置かない
- [ ] 0050 の token / tool イベントと共存する

## Notes

- 0050 はイベントの種類、0118 は購読の単位。両方必要
- 再接続で全履歴を送らない。cursor 以降だけ、または state の再取得を1回
- 0115 の overview を購読するとき、各 conversation の state をサーバーで合成する

## やらないこと

- WebSocket への移行
- 通知の配信（0126）
