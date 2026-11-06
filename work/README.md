# Work tracking

残作業はこのディレクトリにファイルで置く。

- `BOARD.md`: 状態・依存の索引。
- `issues/NNNN-slug.md`: 1 issue 1ファイル。作業した人が status・log・result を更新する。
- `scratch/`: gitignore。一時ファイル。

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
