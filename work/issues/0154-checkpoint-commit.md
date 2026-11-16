# 0154: checkpoint commit（refs/hns・Run 境界）

status: open
priority: next
design: agreed
design-ref: docs/durability.md §5
depends-on: 0153, 0156
touches: packages/workspace/src/checkpoint.ts, packages/workspace/test/checkpoint.test.ts

## Goal

Run の終わりに、作業ツリーを commit にして `refs/hns/checkpoints/<runId>` を進める。
ユーザーのブランチは動かさず、commit を強制しない。

## Acceptance criteria

- [ ] `git stash create` 相当で working tree を commit 化（untracked を含む範囲を決める）
- [ ] `refs/hns/checkpoints/<runId>` を更新。ユーザーの ref は触らない
- [ ] `.gitignore` 対象を含めない
- [ ] Run が失敗・中断したときの checkpoint の有無を決める
- [ ] 同一 Run の再実行で二重に ref を進めない（operationId で冪等）
- [ ] 実リポジトリでのテスト（temp の git、モックなし）

## Notes

- git の object model を CAS として使う。差分転送と dedup が無料でついてくる。
- 0153 の R2 key はこの commit から辿れる object。

## 追記（0127 の sandbox 調査、2026-11-17）

- checkpoint から `.hns`・secret・`.env` を除外する。root を丸ごと保存すると、hide していても資格情報が snapshot に乗る（[agent-sandbox-designs.md](../research/agent-sandbox-designs.md) R8）。

## やらないこと

- ユーザーの commit / push。
- merge / rebase の支援。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
