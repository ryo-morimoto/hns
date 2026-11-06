# 0011: diff の上限撤廃

status: done
depends-on: 0009
touches: work/poc/editor/diff.mjs

## Goal

5,000行 / 100万セルの上限を無くす。大きいファイルでも差分を出す。

## Acceptance criteria

- [x] 行数の上限を撤廃
- [x] 大きいファイルで固まらない
- [x] 出力が入力に戻る（壊れない）

## Result

LCS 一発から、前後の共通部分を削る → 一意な行でアンカー（patience）→ 間だけ LCS に変更。
整列できない巨大な区間は「全削除 + 全追加」に落として、拒否しない。

| ケース | 時間 |
| --- | --- |
| 100k行・1行編集 | 18ms |
| 500k行・1行編集 | 106ms |
| 50k行・全行変更 | 18ms |
| 100k行・1行挿入 | 9ms |

UI はハンク単位で描画（変更の前後3行 + 「… N 行」）。`node bench.mjs` で再現。
