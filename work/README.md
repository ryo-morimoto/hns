# Work tracking

残作業と検証はこのディレクトリ。

- `BOARD.md`: 状態・依存の索引。
- `issues/NNNN-slug.md`: 1 issue 1ファイル。
- `research/`: 提供資料の原文と実測ノート。書き換えない。
- `poc/`: 検証コード。
- `scratch/`: gitignore。

## Issue 形式

```markdown
# NNNN: Title

status: open | in-progress | blocked | done
depends-on: NNNN
touches: 触るパス

## Goal
## Acceptance criteria
- [ ] 検証できる形で書く
## Log
## Result
```
