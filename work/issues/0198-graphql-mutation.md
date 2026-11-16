# 0198: GraphQL の Mutation 面（書き込みの骨格）

status: open
priority: next
design: agreed
design-ref: D077
depends-on: 0176
touches: packages/core/src/graphql/, packages/core/test/graphql/, packages/server/src/graphql/, packages/server/test/graphql/

## Goal

Query しか無い GraphQL に、書き込みの面を足す。feature ごとの mutation を集める骨格だけを作り、最初の実例は 0127 に置く。

## Acceptance criteria

- [ ] `buildSchema(query, mutation?)` が Mutation を任意で受ける。Query だけの呼び出しは今までどおり
- [ ] Mutation root は feature ごとの `mutations/<name>.ts` を集める（1 feature = 1 module）。resolver は認可を行う
- [ ] Mutation が無い間は schema に Mutation を出さない（field の無い object type を作らない）
- [ ] 想定内の失敗は union（HTTP 200）。入力不正・未知 operationName は 400。上限（深さ・複雑度・行）は Query と同じ
- [ ] 契約テスト: テスト用 mutation で parse → validate → execute → union の経路を通す
- [ ] 最初の実例は 0127（Project の作成（root 付き））。0198 の直後に置く
- [ ] `npm run check` が通る

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | Query だけで build → SDL に Mutation が無い | 中 | 受入3 |
| C2 | fixture mutation → execute → payload / QueryFailure の union が返る | 高 | 受入4 |
| C3 | 未認証 → POST /graphql → 401 で resolver に届かない | 高 | 0145 |
| C4 | 入力不正 / 未知 operationName → 400（500 にしない） | 中 | 受入4 |
| C5 | `npm run check` | 高 | 受入7 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 / C2 | 同値分割 | unit | `packages/core/src/graphql/index.test.ts`、`packages/server/src/graphql/handler.test.ts` |
| T2 | C3 / C4 | 既存の回帰 | unit | `packages/server/src/graphql/handler.test.ts` |
| T3 | C5 | ゲート | static / build | `nix develop --command npm run check` |

## Notes

- 0176 は Mutation を 400 で拒否し、`buildSchema` は Query root しか取らない。0188 で REST の書き込み面を消したので、いま書き込みの面が無い。
- 空の Mutation は GraphQL の schema 検証で落ちる。Mutation が無い間は root を出さない。
- 認可は resolver（境界）。セッションは edge が検証済み。所有者の確認を resolver で行う。
- feature の module は `packages/server/src/graphql/mutations/<name>.ts`。1 feature が schema・resolver・テストを同じ変更で持つ（D059）。

## やらないこと

- 個々の feature mutation（0127 以降）。
- subscriptions。

## Log

- 2026-11-17: 作成（0182 / D077）。書き込みの面が無く、0104 / 0105 / 0117 / 0123 / 0126 / 0127 / 0131 が着手できない。
