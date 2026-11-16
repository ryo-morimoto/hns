# 0105: Conversation 画面（transcript / streaming / abort）

status: open
priority: next
design: pending
depends-on: 0049, 0102, 0119, 0145, 0146, 0159
touches: packages/web/src/screens/conversation, packages/web/src/components/Transcript.tsx, packages/web/src/components/Composer.tsx, packages/web/src/components/Progress.tsx, packages/web/test/conversation, packages/core/src/stream.ts, packages/server/src/ws.ts

## Goal

仕事の詳細。会話の transcript、進捗、送信・停止、下書き、接続状態を提供する。
エディタは右パネルとして次増分（0106）に分ける。

## Acceptance criteria

- [ ] 0119 で会話を開き、0118 の conversation-scoped SSE で transcript / task / queued を更新
- [ ] 送信前に composer を空にし、二重送信を防ぐ。失敗時だけ同じ会話・空欄のとき戻す
- [ ] 停止は常に同じ位置。abort 後は「中断されました」を transcript と Needs you に反映
- [ ] 下書きは会話ごとに保持。会話切替・戻る・リロードで失わない
- [ ] 進捗は考え中 / ツール実行中 / 待ち。pi.* を出さない。queue は追加分だけ
- [ ] 自動追従は下まで読んでいるときだけ。読んでいる途中は「最新へ」
- [ ] conversation の rename / archive / delete。delete は確認、archive は Undo（0029 の API）
- [ ] empty / loading / error / offline / aborted / 長文 / 100 メッセージ の状態
- [ ] テスト: state 変換、送信、abort、下書き、IME、scroll

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
