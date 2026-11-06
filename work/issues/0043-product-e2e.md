# 0043: 製品の E2E テスト

status: open
depends-on: 0036
touches: packages/web/test, package.json, package-lock.json, .github

## Goal

主要シナリオを実サーバで E2E テストする。ツールは着手時に決める。

## Acceptance criteria

- [ ] ログイン → 会話 → 編集（競合）→ Workflow → Automation
- [ ] 実サーバ + 実 SQLite（モックにしない）
- [ ] CI で実行し、失敗時にスクリーンショットとログ
- [ ] ツールを比較して決め、D 番号で記録する

## Notes

- ツールは未定。決める前に特定の製品へ寄せない。
- E2E は `npm run check` に入れない。別コマンドと CI ジョブにする。

## やらないこと

- ツールを先に固定しない。
- mobile の E2E。
