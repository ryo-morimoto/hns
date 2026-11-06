# 0043: 製品の E2E テスト

status: open
depends-on: 0036
touches: packages/web/test

## Goal

主要シナリオを実サーバで E2E テストする。

## Acceptance criteria

- [ ] ログイン → 会話 → 編集（競合）→ Workflow → Automation
- [ ] 実サーバ + 実 SQLite（モックにしない）
- [ ] CI で実行し、失敗時にスクリーンショットとログ
