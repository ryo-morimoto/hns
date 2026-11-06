# 0041: CI と開発環境の固定

status: open
depends-on: —
touches: work/issues/0004, .github

## Goal

開発環境を固定し、check を CI で強制する。

## Acceptance criteria

- [ ] node を固定する（0004 を閉じる）
- [ ] npm run check を CI で回す
- [ ] 可能なら Playwright の主要シナリオも回す
- [ ] キャッシュと失敗時のログ
