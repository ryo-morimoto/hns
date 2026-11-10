# 0131: Automation の archive / delete

status: open
priority: plan
depends-on: 0038, 0145, 0146
touches: packages/core/src/http.ts, packages/core/src/http-schemas.ts, packages/core/test, packages/store/src, packages/store/test, packages/server/src, packages/server/test

## Goal

Automation を一覧から隠す。firings は残し、schedule / webhook を止める。
enabled=false と archive を区別する（一時停止と引退）。

## Acceptance criteria

- [ ] POST /api/automations/:id/archive と /unarchive
- [ ] archive で trigger を止める。webhook は 410 / 404 のどちらにするか決める
- [ ] 既存 firings は残る。二重 archive は idempotent、不明は 404
- [ ] 監査イベント。UI 0112 に archive / unarchive を出す
- [ ] テスト: schedule 停止、webhook、firings 保持、unarchive

## Notes

- enabled=false は「動かさないが残す」、archive は「一覧から引退」。UI で混同しない
- 0038 の scheduler / hook が archive を無視する
- webhook token は archive 後も URL として残すが、受け付けない

## やらないこと

- 物理削除
- firing の再実行
