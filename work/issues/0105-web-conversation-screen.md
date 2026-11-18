# 0105: Conversation 画面（transcript / streaming / abort）

status: in-progress
priority: now
design: agreed
depends-on: 0102, 0119, 0145, 0146, 0159
touches: packages/web/src/screens/conversation, packages/web/src/components/Transcript.tsx, packages/web/src/components/Composer.tsx, packages/web/src/components/Progress.tsx, packages/web/test/conversation, packages/core/src/stream.ts, packages/server/src/ws.ts

## Goal

仕事の詳細。会話の transcript、進捗、送信・停止、下書き、接続状態を提供する。
エディタは右パネルとして次増分（0106）に分ける。

## 設計（lead）

- **依存から 0049 を外す**。0049 は `usage()` / `inspect()` と server の pi-durable 依存除去で、**画面の受入（transcript / 送信 / 停止 / 下書き / 追従）は 0146 の `openSession` と 0118 の SSE だけで作れる**。usage の表示は画面の受入に無い。
- **状態の取得は 0119 の `/api/conversations/:id/state`**（1 往復）。**一覧の線形探索をしない**。archived は `archived:true` で表示するだけ。
- **送信は 0270n の `sendMessage`**（GraphQL）ではなく **0118 / 0159 の WS フレーム `send`** を使う（D077 の追記どおり。`clientMessageId` で dedupe・再送）。**REST POST を作らない**（既に作らない約束）。
- **component は `packages/web/src/screens/conversation/`** に置き、`Shell` のルートに 1 本足す。**状態変換は純関数**（`conversation/state.ts`）にしてテストする。
- **ストリーミングの delta が無い場合**は state の再取得で動かし、`TODO(0050)` を残す（issue の Notes どおり）。

## Acceptance criteria

- [x] 0119 で会話を開き、0118 の conversation-scoped SSE で transcript / task / queued を更新
- [x] 送信前に composer を空にし、二重送信を防ぐ。失敗時だけ同じ会話・空欄のとき戻す
- [x] 停止は常に同じ位置。abort 後は「中断されました」を transcript と Needs you に反映
- [x] 下書きは会話ごとに保持。会話切替・戻る・リロードで失わない
- [x] 進捗は考え中 / ツール実行中 / 待ち。pi.* を出さない。queue は追加分だけ
- [x] 自動追従は下まで読んでいるときだけ。読んでいる途中は「最新へ」
- [ ] conversation の rename / archive / delete — **0105 の範囲外**: 0029 は done だがその面（PATCH / DELETE）は PoC にしか無く、このパッケージには無い。archived の**表示**だけ実装。**残件**として新しい面の issue を立てる。。delete は確認、archive は Undo（0029 の API）
- [x] empty / loading / error / offline / aborted / 長文 / 100 メッセージ の状態
- [x] テスト: state 変換、送信、abort、下書き、IME、scroll

## Notes

- PoC の「会話は詳細」を守る。ヘッダーからワークスペースへ戻れる
- streaming の delta は 0050 のイベント型。まだ無い場合は state の再取得で動かし、TODO(0050) として残す
- tool result は折りたたみ。code fence / inline code / URL だけを安全に描画する

## 追記（D077 の chat 送信、2026-11-17）

- 0159 は done だが、**client → server の send は未実装**（server → client の delta だけ）。D077 の chat 送信はこの issue が残りを実装する。
- フレーム: `send` { conversationId, clientMessageId, text } / `accepted` { clientMessageId, messageId } / `rejected` { clientMessageId, code }。REST POST は作らない。
- 同じ `clientMessageId` の再送は二重に送らない（DO で dedupe）。切断・再接続で未 ack の send を再送できる。
- 0146 の send RPC を使う。認証は upgrade の session（既存）。
- テスト: 2 回送信 / 切断中の再送 / 未知 conversation / 空 text / 64KiB 超。

## やらないこと

- Editor（0106）
- メッセージ検索・会話の一括管理（0121）
- 通知（0126）

## Result

- verdict: **PASS**（reviewer-0105。コード PASS 後に lead が 4 点を畳ませた。B2 は本物の欠陥）
- HEAD: 6c9bc10（main に ff 統合）。gate は exit 0（1604 tests、main で 152.7s）。
- **実経路**: (a) 画面は `/api/conversations/:id/state` を **1 回だけ**読む（一覧の線形探索なし）。404 / 400 / 5xx の文言、archived の表示。(b) 送信は **WS の `send`**（`clientMessageId` で dedupe、未 ack は再接続で同じ id を再送、server は pending id で 1 回、REST POST なし）。拒否時は**同じ会話かつ空欄のときだけ**戻す。(c) abort は**常に同じ位置**、transcript と進捗に「中断されました」。
- **1 訪問 1 socket**: Shell の ConversationView が 1 本の LiveClient を持ち、screen は渡された client だけを使う（本番経路のテストで socket 数 1 を固定、mutation で検出）。
- 下書きは会話ごと（404 で掃除）、追従は**下まで読んでいるときだけ**（「最新へ」で戻る）、**pi.* を描画しない**、tool result は折りたたみ、描画は text / code / inline code / pre / a(http(s), rel=noreferrer) だけ。
- **レビューで見つかって直したもの**: ①**object が hibernate した後の send / abort が全部拒否**（`#attachSocket` が `chat` を渡していなかった。D077 の再送が evict で壊れる）②**「ツール実行中」が実経路で一度も出ない**（wire の toolCall entry は text が空で、`latestTurn` が assistant の text を要求していた）③`SEAMS` の手書き一覧を **`Record<keyof SessionDependencies, true>` にしてコンパイラで網羅**（新しい seam が素通りした）。
- **残件**: (1) rename / archive / delete は **0029 の面がこのパッケージに無い**ため未実装（archived の表示のみ）。**新しい面の issue を lead が立てる**。(2) Needs you は 0126、実レイアウトのスクロールは 0114、delta の型は 0050（`TODO(0050)` を TSDoc に残した）。(3) 未確認: 実ブラウザでの viewport / IME / 200% ズーム（レビューは jsdom まで）。
