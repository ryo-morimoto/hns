# 0181: store の鮮度方針を画面ごとに決める

status: open
priority: plan
depends-on: 0159, 0179
touches: packages/web/src/live/, packages/web/src/app/, packages/web/test/

## Goal

Relay の store は、満たせる要求を network に行かない。実測では再訪 0 回。これは DO RPC を減らすが、
裏返すと**古いデータを出したまま何も聞きに行かない**。鮮度が意味を持つ画面（Needs you など）で
どう更新するかを決める。

## Acceptance criteria

- [ ] store が古いまま表示されるケースを列挙する（再訪、購読の取りこぼし、切断中の変更）
- [ ] 画面ごとに「購読（0159）」か「明示的な再取得」を決め、テストで固定
- [ ] 切断・再接続時の表示を決める（状態を隠さない）
- [ ] `store-or-network` の既定を画面ごとに変えられるようにする
- [ ] `npm run check` が通る

## Notes

- 実測: store-or-network で再訪 0、既定ポリシーで毎回 1（[RESULTS.md](../../work/poc/graphql-relay/RESULTS.md) §13）
- 0159 の WS は送信が無料・受信が 20:1 なので、購読に寄せると DO 課金は増えない
- 索引（0149）の遅れと store の古さは別の層。両方を説明できるようにする

## やらないこと

- offline-first / 楽観更新の一般化

## Log

- 2026-11-10: 作成（user。D055）。
