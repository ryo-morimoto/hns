# 0198: GraphQL の Mutation 面（書き込みの骨格）

status: done
priority: now
design: agreed
design-ref: D077
depends-on: 0176
touches: packages/core/src/graphql/, packages/core/test/graphql/, packages/server/src/graphql/, packages/server/test/graphql/, work/issues/0198-graphql-mutation.md

## Goal

Query しか無い GraphQL に、書き込みの面を足す。feature ごとの mutation を集める骨格だけを作り、最初の実例は 0127 に置く。

## Acceptance criteria

- [x] `buildSchema(query, mutation?)` が Mutation を任意で受ける。Query だけの呼び出しは今までどおり
- [x] Mutation root は feature ごとの `mutations/<name>.ts` を集める（1 feature = 1 module）。resolver は認可を行う
- [x] Mutation が無い間は schema に Mutation を出さない（field の無い object type を作らない）
- [x] 想定内の失敗は union（HTTP 200）。入力不正・未知 operationName は 400。上限（深さ・複雑度・行）は Query と同じ
- [x] 契約テスト: テスト用 mutation で parse → validate → execute → union の経路を通す
- [ ] 最初の実例は 0127（Project の作成（root 付き））。0198 の直後に置く
- [x] `npm run check` が通る

## Design: guide-level

- **core は root を組み立てない。** `buildSchema(query, mutation?)` は Query の factory（0176 / D073）に加えて、任意で Mutation の factory を受ける。factory は model の object 型の Map を受け取り、schema と同じインスタンスで root を組む（`Project` を二重定義しない）。mutation を渡さない呼び出しは今までどおりで、schema に Mutation は無い。`buildSdl(mutation?)` も同じで、渡したときだけ Mutation root を SDL に足す。
- **空の Mutation を作らない。** GraphQL は field の無い object type を schema 検証で拒否する。server は登録 module が空なら factory 自体を渡さないので、`MUTATION_MODULES` が空の間は schema にも SDL にも Mutation が出ない。
- **1 feature = 1 module。** `packages/server/src/graphql/mutations/<name>.ts` が `MutationModule`（`name` と field 群）を export し、`mutations/index.ts` の `MUTATION_MODULES` が集める。module は payload / union / resolver / テストを同じ変更で持つ（D059）。今は module が無く、テスト用の fixture だけがある。
- **認可は resolver。** edge（0145）は「有効なセッションがある」ことだけを証明する。`GraphQLContext.session` が検証済みの呼び出し元で、各 module の resolver が対象（所有者）を確かめる。fixture は owner 以外を `forbidden` の union で断る。
- **失敗の形は Query と同じ規則。** 想定内（認可・入力・行予算・D1 / DO の不達）は union（HTTP 200）。要求が成立しない（JSON でない・構文 / 検証で落ちる・上限超過・query / mutation 以外）は 400。想定外だけ 500。上限は 0176 の値（8 KiB / 深さ 8 / field 500 / 行 500・100）を再定義せず共有する。

## Design: reference-level

```text
packages/core/src/graphql/
  schema.ts        # buildSchema(query, mutation?) / buildSdl(mutation?) / MutationRootFactory
  index.ts         # 公開（MutationRootFactory を足す）
packages/server/src/graphql/
  schema.ts        # buildGraphQLSchema(modules) / buildSchemaSdl(modules)。modules が空なら Mutation root 無し
  mutations/index.ts   # MutationModule / MUTATION_MODULES / buildMutationRoot(objects, modules)
  mutations/failure.ts # MUTATION_FAILURE_CODES / MutationFailureView / MutationFailureType
  context.ts       # GraphQLContext.session（検証済みの呼び出し元）
  handler.ts       # parse → bytes → depth / complexity → operation 種別 → validate → execute → 200 / 400 / 500
packages/server/test/graphql/
  fixture-mutation.ts  # テスト用 mutation（notes。owner だけが createNote できる）
```

| 何を | どこが | 決めること |
| --- | --- | --- |
| root の組み立て | core `schema.ts` | Mutation を渡さなければ root を作らない（空の型を作らない） |
| module の集約 | server `mutations/index.ts` | 同名 field は構築時に拒否。module は model の object 型を受け取る |
| 失敗の語彙 | server `mutations/failure.ts` | `MutationFailure`（`forbidden` / `invalid_argument` / `limit_exceeded` / `unavailable`） |
| 呼び出し元 | server `context.ts` | edge が検証した `session` を resolver へ渡す |
| 経路 | server `handler.ts` | mutation も同じ上限・同じ 400 / 500 の分類 |

| 失敗 | HTTP | 返すもの |
| --- | --- | --- |
| 認可（所有者でない） | 200 | `MutationFailure(code: FORBIDDEN)` |
| 引数不正（resolver の検証） | 200 | `MutationFailure(code: INVALID_ARGUMENT)` |
| 行予算超過 | 200 | `MutationFailure(code: LIMIT_EXCEEDED)` |
| D1 / DO の不達 | 200 | `MutationFailure(code: UNAVAILABLE)` |
| 変数 coerce・未知 operationName・未知 field・上限超過 | 400 | GraphQL error envelope（`GRAPHQL_REQUEST_INVALID`） |
| resolver の想定外の throw | 500 | GraphQL error envelope（`GRAPHQL_INTERNAL`） |

- `MutationFailure` は `QueryFailure` と別の型にした。`QueryErrorCode` に `forbidden` を足すと、mutation が1つも無い間も公開 schema（`packages/web/schema.graphql`）が変わるため。mutation 専用の型は module が無い間は schema から到達不能で、SDL と relay の生成物は変わらない。
- `buildSdl(mutation)` は root だけを model 型の後に出す。payload / union は module（呼び出し側）の型なので、完全な SDL は server の `buildSchemaSdl`（`printSchema`）が責任を持つ。

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | Query だけで build → schema に Mutation が無く、`buildSdl()` は今の golden と一致 | 中 | 受入1・3 |
| C2 | fixture mutation を登録 → execute → payload（200）と MutationFailure（200）の union が返る | 高 | 受入4・5 |
| C3 | 未認証 → POST /graphql → 401 で resolver に届かない | 高 | 0145 |
| C4 | 入力不正（変数 coerce・未知 mutation field）・未知 operationName → 400、resolver は呼ばれない | 高 | 受入4 |
| C5 | mutation が深さ・複雑度・バイト上限を超える → 400 で実行されない | 中 | 受入4 |
| C6 | 行予算 0 の mutation → 200 で MutationFailure(limit_exceeded) | 中 | 受入4 |
| C7 | 所有者でない呼び出し元 → 200 で MutationFailure(forbidden) | 高 | 受入2 |
| C8 | module を1つ登録 → Mutation root にその field。module 無し → root 無し。同名 field は構築時に拒否 | 高 | 受入2・3 |
| C9 | 既定の server SDL に Mutation が無く、relay の `schema.graphql` に差分が無い | 中 | 受入3 |
| C10 | `npm run check` | 高 | 受入7 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 | 同値分割 | unit | `packages/core/src/graphql/index.test.ts`（任意 Mutation・golden・インスタンス共有） |
| T2 | C8 | 同値分割・故障注入 | unit | `packages/server/src/graphql/mutations/index.test.ts`（同名 field / 空 module / object 型の受け渡し） |
| T3 | C2, C4, C5, C6, C7 | 契約テスト・同値分割 | unit | `packages/server/src/graphql/handler.test.ts`（fixture mutation を edge 経由で POST） |
| T4 | C9 | 回帰 | unit | `packages/server/src/graphql/schema.test.ts` + codegen の再生成（差分なし） |
| T5 | C3 | 既存の回帰 | unit | `packages/server/src/edge/handler.test.ts`（新規に作らない） |
| T6 | C10 | ゲート | static / build | `npm run check` |

## Notes

- 0176 は Mutation を 400 で拒否し、`buildSchema` は Query root しか取らなかった。0188 で REST の書き込み面を消したので、いま書き込みの面が無い。
- 空の Mutation は GraphQL の schema 検証で落ちる。`modules` が空のときは factory を渡さず、空の object type を作らない。
- 認可は resolver（境界）。セッションは edge が検証済み。所有者の確認を resolver で行う。
- feature の module は `packages/server/src/graphql/mutations/<name>.ts`。1 feature が schema・resolver・テストを同じ変更で持つ（D059）。`MUTATION_MODULES` は 0127 まで空。
- 上限は Query と同じ値・同じ関数（`assertWithinLimits` は operation の種別を見ない）。行予算も `context.budget` を共有する。
- fixture はテスト専用で `packages/server/test/graphql/` に置く。本番の `MUTATION_MODULES` には入れない（入れると relay の schema が不要に変わる）。

## やらないこと

- 個々の feature mutation（0127 以降）。
- subscriptions。
- `MutationFailure` を `QueryFailure` に統合すること（mutation が無い間の公開 schema を変えないため）。
- persisted query。

## Log

- 2026-11-17: 作成（0182 / D077）。書き込みの面が無く、0104 / 0105 / 0117 / 0123 / 0126 / 0127 / 0131 が着手できない。
- 2026-11-17: 第2波の後に lead が `next` から `now` へ。Query しか無い GraphQL に書き込みの骨格を足す最優先の前提。
- 2026-11-17: 実装。core の `buildSchema(query, mutation?)` / `buildSdl(mutation?)`、server の `mutations/`（module 契約・集約・`MutationFailure`）と `GraphQLContext.session`、handler の mutation 許可。fixture mutation で parse → validate → execute → union の契約テストを追加。
- 2026-11-17: `npm run check` exit 0（lint / fmt / codegen / typecheck / 120 files・729 tests / build / deploy dry-run / knip、38 秒）。codegen の再生成で `packages/web/schema.graphql` と relay の artifact に差分なし。受入は 0127 の実例を除いて充足（レビュー待ち）。
## Result

- verdict: **PASS**（reviewer-0198、blocking 0）
- reviewer: reviewer-0198（この変更を書いていない別エージェント）
- HEAD: bd33178（main に ff 統合）
- 受入: 7/7。最初の実例（createProject）は 0127 が持ち、0198 はその骨格まで（D080）。
- 確認: buildSchema(query, mutation?) / buildSdl(mutation?) の任意 Mutation、Mutation 未指定の golden 一致、Mutation が無い間は root を出さない（getMutationType undefined）。feature module の集約・同名 field の拒否・context.session の認可。MutationFailure を QueryFailure と分けたことで既定 SDL は不変（codegen 差分なし）。handler は bytes → depth/complexity → validate → execute、union 200 / 要求不正 400 / 上限は Query と同じ。fixture createNote の契約テスト。
- 非 blocking（低 8、follow-up）: nullable な root field の resolver throw が 200 + errors（0127 の module 契約で NonNull を必須にするか 500）/ default schema に MutationFailure が無いことの直接断言 / complexity 上限のテストが binding でない（maxComplexity: 1）/ AC の「入力不正」の文言 / fixture の TSDoc に issue 番号 / core・server の CHANGELOG 未更新 / buildSdl の型構築の二重化 / fixture を test/support に置くかの根拠。
- 未確認: 0127 の実 mutation と D1 write、cf dev の port 競合 flake。
