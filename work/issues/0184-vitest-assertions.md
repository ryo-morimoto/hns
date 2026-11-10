# 0184: テストのアサーションを Vitest の expect に統一する

status: done
priority: now
depends-on: 0185
touches: packages/*/test/**, tools/gate/test/**, docs/testing.md, AGENTS.md

## Goal

テストから node:assert/strict を外し、Vitest の expect に統一する。D038 のアサーション固定を D056 で置換する。振る舞いは変えない。

## Acceptance criteria

- [x] テストの node:assert/strict import をすべて削除する（24ファイル）
- [x] assert.equal / deepEqual / notEqual / ok / throws / rejects / match / doesNotThrow を expect に置換する（427アサーション）
- [x] 型の絞り込みが必要な箇所は expect.assert(...) にする（as を増やさない）
- [x] tsrs --noEmit と npm test が通る（162 passed）
- [x] tools/gate のテストも同じ規約にする
- [x] D056 と AGENTS / docs の記述を更新する

## Notes

- 対象は 24ファイル / 427アサーション。0185 後のツリーには、統合済み pending lane で削除された core/http・schemas・contract と web/client・fixtures の5ファイルが含まれない。テストのベースラインは 162 passed（以前の 224 ではない）。
- assert.ok は boolean 確認と narrowing が混在。assert.equal にも narrowing があった（store の run、sandbox の available）。
- assert.equal はプリミティブなら toBe、オブジェクトなら toStrictEqual。
- assert.rejects は await expect(p).rejects.toThrow()。
- 型の絞り込みは `expect.assert(...)` に統一する（`defined()` ヘルパーは作らない）。
- 1ファイルずつ移行し、都度テストを回す。一括置換はしない。
- 振る舞いを変えないので、テストの追加・削除はしない。

## やらないこと

- テストの移動（0186）
- 新しいテスト（0187）
- tiers の削除（0185 で実施済み。ここでは触らない）

## Log

- 2026-11-10: 作成（user）。node:assert 固定は早すぎる決定として削除し、Vitest に統一する。
- 2026-11-10: 372件の単純変換（equal/deepEqual/notEqual/match/throws/rejects/doesNotThrow）と、47件の assert.ok を codemod で変換。残り13件の絞り込み（assert.ok 9 + assert.equal 4）は `expect.assert(...)` にした。
- 2026-11-10: `assert.equal` の narrowing（store の run、sandbox の available）を `expect.assert` で補い、`npm run typecheck` を通した。
- 2026-11-10: `npm test` 162 passed、`npm run check` 成功。
- 2026-11-10: reviewer-0184 が **PASS**（blocking なし）。low 2件（D056 の defined() 記述、Log の件数）を修正し、D061 を追記。
- 2026-11-11: B 修正。13箇所の絞り込みを `node:assert` に戻し、D062 で D056 / D061 を置換した。通常のアサーションは `expect` のまま。

## Result

- verdict: **PASS**（reviewer-0184。blocking なし）
- reviewer: reviewer-0184
- HEAD: cd13f67 + B 修正
- blocking findings: なし
- 未確認: assertion ごとの mutation test、`toStrictEqual` の全値での同等性、メッセージ診断の網羅。レビューの green run は HEAD f4ca217 時点。
- 0184 の expect 移行は 72e4704 / cd13f67 でコミット済み。B 修正（assert 復帰 + D062）は追加コミットに含む。
