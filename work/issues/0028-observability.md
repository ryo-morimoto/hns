# 0028: 観測（要件17）

status: done
depends-on: 0014
touches: work/poc/app

## Goal

何が起きたかを後から追える。壊れたときに原因へ辿り着ける。

## Acceptance criteria

- [x] HTTP リクエストを記録（status・所要・相関 ID）
- [x] 会話の開始・終了・中断を記録
- [x] 直近のイベントを API で読める
- [x] 件数・status 別・p50/p95・利用量を集計
- [x] token など機密をログに残さない

## Result

- `events` テーブル、`/api/events`、`/api/metrics`、`x-request-id`。
- エージェントのターン（`agent.response`）とツール（`tool.call` / `tool.result`）は Durable の hooks から記録。引数・出力の中身は残さない。
- 起動時に30日より古いイベントを削除。
- テスト `run-observe.mjs` 17/17。