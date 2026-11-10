# 0163: コストの上限と監視（DO 行・R2・モデル）

status: open
priority: plan
depends-on: 0151, 0153
touches: packages/server/src/cost/, deploy/limits/

## Goal

課金が設計ミスで増える経路（行数・PUT 回数・トークン）を計測可能にし、上限をかける。

## Acceptance criteria

- [ ] 1 ターンあたりの DO 行数・リクエスト数・R2 オブジェクト数を記録
- [ ] token 単位 commit を検出するテスト（行数が閾値を超えたら失敗）
- [ ] 月次の運用上限（DO / R2 / provider）とアラート
- [ ] 使いすぎたときの縮退（新しい Run を止める）
- [ ] 実測値を RESULTS に追記する場所を決める

## Notes

- 見積り: 月 1 万ターンで Cloudflare は $6〜7。支配的なのはモデル代。
- 設計ミスの例: token 単位 commit で行数 100〜500 倍、mutation ごとの PUT で Class A 増。

## やらないこと

- 課金の請求書連携。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
