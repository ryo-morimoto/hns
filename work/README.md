# Work tracking

残作業と検証はこのディレクトリ。

- `BOARD.md`: 状態・依存・並列の索引。
- `issues/NNNN-slug.md`: 1 issue 1ファイル。
- `research/`: 提供資料の原文と実測ノート。書き換えない。
- `poc/`: 検証コード。
- `scratch/`: gitignore。

## Issue 形式

```markdown
# NNNN: Title

status: open | in-progress | blocked | done
depends-on: NNNN, NNNN
touches: 触るパス

## Goal
## Acceptance criteria
- [ ] 検証できる形で書く
## Notes
## やらないこと
## Log
## Result
```

## 並列作業

1 issue = 1 ブランチ。`issue/NNNN-slug` を main から切る。BOARD の「並列の単位」で、いま並列してよい組み合わせを見る。

- `touches` は契約。書いていないファイルは触らない。必要になったら、先に issue の `touches` を更新する。
- `depends-on` が未マージなら着手しない。依存先のファイルを先回りして変えない。
- `package.json` / `package-lock.json` を触る issue は同時に1つ（lock owner）。依存を足さない issue は触らない。
- 同じ `packages/*` を触る issue は直列。別パッケージなら並列可。
- マージ前に main へ rebase し、`npm run check` を通す。マージ後に壊れたら、マージした側が直す。
- 1 issue 1目的。ついでの整形・改名・依存追加を混ぜない。
- `## やらないこと` に、その issue でやらないことと、先回りしない将来作業を書く。
