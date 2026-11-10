# 0184: テストのアサーションを Vitest の expect に統一する

status: open
priority: plan
depends-on: 0185
touches: packages/*/test/**, tools/gate/test/**, docs/testing.md, AGENTS.md

## Goal

テストから node:assert/strict を外し、Vitest の expect に統一する。D038 のアサーション固定を D056 で置換する。振る舞いは変えない。

## Acceptance criteria

- [ ] テストの node:assert/strict import をすべて削除する（0185 後の対象ファイル）
- [ ] assert.equal / deepEqual / notEqual / ok / throws / rejects / match / fail / doesNotThrow を expect に置換する
- [ ] 型の絞り込みが必要な箇所は defined() ヘルパーか明示チェックにする（as を増やさない）
- [ ] tsrs --noEmit と npm test が通る
- [ ] tools/gate のテストも同じ規約にする
- [ ] D056 と AGENTS / docs の記述を更新する

## Notes

- 0185 の後なので対象ファイル数は変わる（tiers の削除・統合後）。assert.ok は boolean 確認と narrowing が混在している。
- assert.equal はプリミティブなら toBe、オブジェクトなら toStrictEqual。
- assert.rejects は await expect(p).rejects.toThrow()。
- 1ファイルずつ移行し、都度テストを回す。一括置換はしない。
- 振る舞いを変えないので、テストの追加・削除はしない。

## やらないこと

- テストの移動（0186）
- 新しいテスト（0187）
- tiers の削除（0185 で実施済み。ここでは触らない）

## Log

- 2026-11-10: 作成（user）。node:assert 固定は早すぎる決定として削除し、Vitest に統一する。
