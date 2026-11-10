# 0159: ライブ更新の WS 化（SSE の置き換え）

status: open
priority: plan
depends-on: 0146
touches: packages/server/src/ws.ts, packages/core/src/stream.ts, packages/web/src/live/

## Goal

会話のライブ更新を Session DO の WebSocket に寄せる。0050 と 0118 をこの形で置き換える。

## Acceptance criteria

- [ ] WS のメッセージ型を core に置き、閉じた union にする
- [ ] 再接続で取りこぼさない（snapshot → 差分の順、cursor 付き）
- [ ] hibernation 中でもメッセージが届く（`acceptWebSocket`）
- [ ] token の delta は間引いて送る（フレーム数の上限をテストで固定）
- [ ] 切断中の状態を UI が説明できる

## Notes

- PoC はポーリング（run.mjs）。WS は未実装。
- フレーム数を増やすと DO のリクエスト課金とレイテンシの両方に効く。100ms か 64KB でまとめる。

## やらないこと

- SSE の併存。移行が済んだら消す。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
