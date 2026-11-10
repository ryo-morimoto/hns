# 0008: Editor の最小

status: done
depends-on: —
touches: work/poc/editor, work/poc/walking-skeleton/server.mjs

## Goal

ブラウザでファイルを開き、編集し、版を確認して保存する。競合したら黙って上書きしない。

## Acceptance criteria

- [x] 一覧・オープン・編集・保存が動く
- [x] dirty と保存済みを区別する
- [x] 外部変更 → 保存で `conflict`、ローカルの内容は保持
- [x] Reload（外部の内容を取る）と Overwrite（競合版を上書き）を選べる

## Result

`work/poc/editor` **14/14**。素の HTML + ES module。`serve.mjs` で起動。
残り: diff の表示（0009）、ファイルツリーの操作性、大きなファイル。
