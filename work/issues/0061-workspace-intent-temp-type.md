# 0061: JournalIntent.temp の「無い」を型で表す

status: open
depends-on: 0045
touches: packages/workspace

## Goal

conflict を記録した intent は `temp: ""` を持つ。型は `temp: string` なので「空文字」と「temp が無い」が
区別できない。union（intent | conflict）か `temp?: string | undefined` にして、意味を型に載せる。

## Acceptance criteria

- [ ] `JournalIntent` の型と journal の schema を合わせる（`temp` を任意にするか、記録を union に分ける）
- [ ] 既存の journal（`""` を含む）を読めること（移行）
- [ ] conflict の記録・再送・recover が今までどおり動く回帰テスト

## Notes

- `#trimOps` と `#reconcile` は `temp` を使わないので、型の変更は局所的。
- 空文字を sentinel にしない、が目的（`null`/absent の区別を型で持つ）。

## Log

- 2026-11-07: 作成（コードレビューで `temp: ""` の意味が型に出ていないのを見つけた）。
