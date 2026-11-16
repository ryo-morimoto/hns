# 0159: ライブ更新の WS 化（SSE の置き換え）

status: open
priority: now
design: agreed
design-ref: D047
depends-on: 0146
touches: packages/server/src/ws.ts, packages/core/src/stream.ts, packages/server/src/do/session.ts, packages/server/test/do/, packages/web/src/live/, packages/web/src/app/, packages/web/test/live/, work/issues/0159-live-ws.md

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

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。- 2026-11-17: ユーザーの判断で `plan` から `now` へ昇格。レーン L2。3本が空くまで待機し、`do/session.ts` と `web/src/app/` を touches に足した。
