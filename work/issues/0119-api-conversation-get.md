# 0119: 会話の単体取得と state のメタデータ

status: open
priority: hold
depends-on: 0037, 0145, 0146
touches: packages/core/src/http.ts, packages/core/src/http-schemas.ts, packages/core/test/http.test.ts, packages/server/src, packages/server/test

## Goal

会話画面が、一覧を引かずに1つの会話のメタデータ（title / project / archived / updated_at）を得る。
/api/state と会話メタの取得を1往復にまとめる。

## Acceptance criteria

- [ ] GET /api/conversations/:id を追加。Conversation を返し、deleted / 不明は 404
- [ ] archived の会話は取得できる。UI がアーカイブ済みと表示できる
- [ ] /api/state の応答に conversation の要約を含める（または GET と同時に取得できる形）
- [ ] web 0105 が一覧の線形探索をしない
- [ ] 契約テストと 404 / archived の server テスト

## Notes

- Conversation の型は core の既存 DTO。web で再定義しない
- 一覧の検索 / pagination は 0121。ここは単体だけ
- deleted_at の扱いは 0029 の論理削除に合わせる

## やらないこと

- 一覧の pagination（0121）
- 会話の検索（0121）
