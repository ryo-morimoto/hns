# 0119: 会話の単体取得と state のメタデータ

status: in-progress
priority: now
design: agreed
depends-on: 0145, 0146
touches: packages/core/src/graphql, packages/server/src, packages/server/test

## Goal

会話画面が、一覧を引かずに1つの会話のメタデータ（title / project / archived / updated_at）を得る。
/api/state と会話メタの取得を1往復にまとめる。

## 設計（lead）

- **面は REST**（既存の `/api/*` に合わせる。GraphQL は対話の一覧に既にあり、0105 は単体を 1 往復で欲しい）。
- `GET /api/conversations/:id` は **session 認証**（未認証 401）。**deleted / 未知は 404**、archived は 200 で `archived: true`。
- `/api/state` の応答に **`conversation` の要約**を足す（0105 が一覧の線形探索をしない）。**加算**で、既存の field は変えない。
- 応答の型は **core の既存 DTO**（web で再定義しない）。

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
