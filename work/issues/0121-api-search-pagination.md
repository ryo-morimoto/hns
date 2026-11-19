# 0121: 一覧の検索と cursor pagination

> 前提変更: 検索と pagination は D1 の索引（0149）。DO に横断クエリは無い。

> 前提変更: 検索と pagination は D1 の投影（0149）。DO に横断クエリは無い。

status: open
priority: parked
design: pending
depends-on: 0047, 0145, 0146
touches: packages/core/src/http.ts, packages/core/src/http-schemas.ts, packages/core/test/http.test.ts, packages/store/src, packages/store/test, packages/server/src, packages/server/test

## Goal

会話・タスク・run・event の一覧を、増えても破綻しない形にする。
offset ではなく cursor で、検索語と limit を受ける。

## Acceptance criteria

- [ ] GET /api/conversations / tasks / runs / events に q と cursor / limit を追加
- [ ] 応答は items と next_cursor。limit は 1–100、既定 50。next_cursor は不透明
- [ ] 並びは updated_at + id の keyset。同じ updated_at でも欠落/重複しない
- [ ] q は title / name の部分一致。SQL の LIKE でもよいが、index と上限を明記
- [ ] 不正 cursor / limit は 400。unknown project は 404
- [ ] テスト: 境界、重複なし、q、cursor の継続、削除済みの除外

## Notes

- 全文検索はまだ入れない。会話の本文検索は必要になったら別 issue
- web 0104 / 0105 / 0109 が使う。UI は next_cursor を「もっと見る」にだけ使う
- 既存の limit だけの応答と互換を保つか、破壊的変更にするかを issue 内で決める

## やらないこと

- 全文検索 / ランキング
- 横断検索（会話 + ファイル + run）
