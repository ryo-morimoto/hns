# 0104: Workspace 画面（Running / Needs you / Completed）

status: open
priority: next
design: pending
depends-on: 0102, 0115, 0117
touches: packages/web/src/screens/workspace, packages/web/src/components/WorkCard.tsx, packages/web/src/components/StatCard.tsx, packages/web/test/workspace

## Goal

製品の既定画面。0115 の overview から、実行中 / あなたの判断 / 完了を出す。
会話を開かずに、待ちへの入力・タスク状態・確認済みをその場で行う。

## Acceptance criteria

- [ ] 3指標（実行中 / あなたの判断 / 完了）と、Needs you を最上段・全幅で表示
- [ ] Needs you: waiting run / failed run / blocked task / blocked・aborted・incomplete conversation。理由コードを UI 文言に写す
- [ ] Running: run のノード進捗、応答中の会話。Completed: 結果要約、結果/開く
- [ ] 仕事を頼む dialog（goal → conversation → chat）と、run への入力、task の状態変更、会話の Ack
- [ ] empty / loading / error / offline / long title / 大量カード の状態
- [ ] J / K でカード移動、Enter で主アクション。カードは focus-visible
- [ ] 0115 のレスポンス型を使い、conversation ごとの state を N 回呼ばない
- [ ] テスト: model 変換、状態ごとの render、Needs you の入力、Ack、キーボード

## Notes

- カードは kind ではなく、0115 の reason / work item を表示の根拠にする
- 横断のワークスペース要約はサイドバー（0102 + 0115）。この画面は選択中のワークスペースの 3 指標に集中する
- 「確認済み」は作業完了にしない。0117 の ack を呼び、updated_at が変われば再表示
- 完了の並びは updated_at 降順。Needs you は理由の重要度 → 古い順
- PoC の 3指標・full-width・2カラム完了を維持する（INTENT I2）

## やらないこと

- Conversation / Editor の中身（0105 / 0106）
- Workflow の作成（0111）
- 通知（0126）
