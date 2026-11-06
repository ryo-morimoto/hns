# 0009: diff の表示

status: open
depends-on: 0008
touches: work/poc/editor, docs/workspace.md

## Goal

競合したとき、外部の版とローカルの版の差を見せる。保存前にも変更が見えるようにする。

## Acceptance criteria

- [ ] 競合時に外部版との差分を表示
- [ ] 保存前の変更を diff で確認できる
- [ ] 大きいファイルで固まらない（行数上限かストリーム）

## Log

- 2026-11-06: 作成。今は local content を保持するだけ。
