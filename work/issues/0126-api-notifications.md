# 0126: Attention 通知（in-app / desktop / webhook）

status: open
priority: next
design: pending
depends-on: 0102, 0115, 0145, 0146, 0159
touches: packages/core/src/http.ts, packages/core/src/http-schemas.ts, packages/core/test, packages/server/src, packages/server/test, packages/web/src/app/notifications.ts

## Goal

Needs you が増えたときに、タブを見ていなくても気づけるようにする。
in-app の badge、タブタイトル、任意の desktop notification を、重複なく出す。

## Acceptance criteria

- [ ] 0118 の overview イベントで needs の追加だけを通知候補にする
- [ ] in-app badge / tab title は常に。desktop Notification は権限があるときだけ
- [ ] 同じ work item / revision の通知は dedupe。ack / 完了で取り下げ
- [ ] 通知クリックで該当 WorkItem を開く。秘密・本文の先頭を通知に出さない
- [ ] 通知の on/off と permission を UI で設定できる
- [ ] テスト: dedupe、ack、権限拒否、クリック

## Notes

- 0104 の Workspace と 0102 の shell が使う
- Push サーバーはまだ作らない。Web Push が必要になったら別 issue
- 通知は「判断が必要」だけ。完了や進捗の通知はノイズなので出さない

## やらないこと

- email / SMS / Slack
- マルチユーザーの通知設定
