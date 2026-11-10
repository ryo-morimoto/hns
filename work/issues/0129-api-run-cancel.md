# 0129: Workflow run のキャンセル

status: open
priority: plan
depends-on: 0038, 0145, 0146
touches: packages/core/src/types.ts, packages/core/src/http.ts, packages/core/src/http-schemas.ts, packages/core/test, packages/server/src, packages/server/test

## Goal

実行中 / 待機中の Workflow run を、UI から止められるようにする。
会話の abort と同じく、止めたことを状態として残し、勝手に再実行しない。

## Acceptance criteria

- [ ] POST /api/runs/:id/cancel（または abort）。queued / running / waiting を受け付ける
- [ ] running のノード会話 / tool を中断し、ノードを cancelled にする
- [ ] run の status に cancelled を追加するか、failed + reason で表すかを決めて閉じた union にする
- [ ] 二重 cancel は idempotent。done / failed は 409、不明は 404
- [ ] 再起動時に cancelled を running に戻さない。監査イベントを残す
- [ ] テスト: queued / running / waiting、二重、done、再起動

## Notes

- 0110 の Run 画面が使う
- 0038 の逐次実行を壊さない。cancel は次のノードを開始しない
- 「中断」と「失敗」を UI で混同しない。理由コードを持つ

## やらないこと

- 部分的なロールバック
- Automation の firing cancel（必要なら別 issue）
