# 0176: Worker に /graphql を載せる

status: in-progress
priority: now
depends-on: 0145, 0146, 0150, 0175, 0188
touches: packages/core/src/graphql/, packages/server/src/graphql/, packages/server/src/session-name.ts, packages/server/src/edge/worker.ts, packages/server/src/edge/worker.test.ts, packages/server/package.json, package-lock.json, vitest.config.ts, docs/decisions.md, work/issues/0176-graphql-endpoint.md, work/BOARD.md, work/LANES.md

## Goal

0145 の Worker に `/graphql` の schema・resolver・上限を足す。口（3面の1つ）と認証は 0145 が持つ。
resolver は DO か D1 のどちらを読むかを明示する。

## Acceptance criteria

- [ ] `POST /graphql` のみ。GET は 405。0145 の認証を通し、未認証は 401 で fail closed
- [ ] query の長さ・深さ・複雑度の上限を決めて実装（値と根拠を Notes に書く）
- [ ] resolver ごとに読み先（Session DO / D1）を明示する。暗黙の fan-out を作らない
- [ ] 想定内の失敗は GraphQL の union で返す（HTTP は 200）。想定外だけ 500
- [ ] 相関 ID を resolver まで通す（0145）
- [ ] 契約テスト: HTTP で直接叩く（画面を経由しない）
- [ ] `npm run check` が通る

## Notes

- 実装の出発点: [work/poc/graphql-relay/src/gql.mjs](../../work/poc/graphql-relay/src/gql.mjs)
- まとめ読みは resolver の単位で明示する（PoC の DataLoader 相当）。RPC 数をテストで固定する
- 計測: WS ごとにまとめると 12 RPC、会話ごとだと 40/120（[RESULTS.md](../../work/poc/graphql-relay/RESULTS.md)）
- 索引（0149）はまだ無いので、初期は会話を DO から読む（12 RPC/画面、実測 $0.39/月 @300k loads）。
  Project / Task は D1（0150 のドライバ）。この2つの読み先が揃うまで着手しない。

## Design: guide-level

- `/graphql` は `packages/server/src/graphql/` の1モジュール。edge（0145）は認証・body 上限・期限・相関 ID を持ち、face は JSON を parse し、schema で validate して execute する。
- 読み先は resolver ごとに固定する。projects / tasks は D1、conversations は Session DO の RPC。resolver は他の resolver を呼ばない（暗黙の fan-out を作らない）。
- 想定内の失敗（binding 不在、D1 / DO の失敗、引数不正、行数超過）は Query の union で返す（HTTP 200）。要求そのものが解決不能（JSON でない、query が構文・検証で落ちる）は 400、想定外だけ 500。
- schema は `buildSchema((objects) => QueryRoot)` で組む（D073）。Query は model の型インスタンスをそのまま参照する（同名の型を2つ作らない）。

## Design: reference-level

```
packages/server/src/graphql/
  index.ts        # face の公開
  schema.ts       # Query root、payload 型、union、buildGraphQLSchema()
  views.ts        # model → GraphQL view（camelCase）の写像
  resolvers.ts    # 3 つの Query resolver（読み先をここで名指す）
  queries.ts      # query の長さ・深さ・複雑度
  context.ts      # request ごとの文脈。D1 の open（isolate 1回）と DO RPC
  handler.ts      # parse → validate → limits → execute → respond
  *.test.ts       # unit（schema / views / limits / handler 契約）
packages/server/src/session-name.ts  # "default"。edge と resolver が同じ名前を使う
```

| 上限 | 値 | 根拠 |
| --- | --- | --- |
| query の長さ | 8 KiB | 手書きの画面 query は 2 KiB 前後。大きめの fragment を許しつつ、解析と検証の費用を抑える |
| 深さ | 8 | model の階層は 2（Query → list → type）。wrapper を足しても 8 で足り、再帰的な query を弾ける |
| 複雑度（field 数） | 500 | 1画面 30 field 前後の 10 倍。PoC の 12 RPC/画面をまとめても余る |
| 行数 / request | `maxRowsPerRequest`（500） | 0145 の既存の予算を resolver が共有する |
| 行数 / list | `maxRowsPerList`（100） | 0145 の既存。`first` はここで clamp する |
| 本文 | 1 MiB | 0145 の既存 |

| Query field | 読み先 | RPC |
| --- | --- | --- |
| `projects(first)` | D1 `store.projects.list()` | 1 |
| `tasks(projectId, first)` | D1 `store.tasks.list(projectId)` | 1 |
| `conversations(projectId, first)` | Session DO `GET /rpc/conversations`（projectId で絞る） | 1 |

1画面 = 3 RPC。PoC の実測（12 RPC/画面）より少ない。D1 の open は isolate の初回だけ（0189。0149 が provider に置き換える）。

## 未確定

| ID | 論点 | 仮説 | 決める時 |
| --- | --- | --- | --- |
| E-01 | query の上限値 | 深さ 10 / 複雑度 1000 | 実装時 |
| E-02 | persisted query | 今は入れない。必要になったら | 0179 の後 |

## やらないこと

- subscriptions（0159）
- passkey / hooks / 運用 / ファイル本文の GraphQL 化
- REST ROUTES の削除

## Log

- 2026-11-10: 作成（user。D055）。
- 2026-11-10: 0188 で REST 契約を撤去したため、0176 は「ルートを足す」ではなく schema・resolver・上限を足す担当。
- 2026-11-16: 実装。`packages/server/src/graphql/`（schema / views / resolvers / queries / context / handler）、`session-name.ts`、`buildSchema` を Query factory にする変更（D073）、worker の配線。query の上限は 8 KiB / 深さ 8 / field 500。unit 11 本（handler 契約）+ 5 本（limits）+ 2 本（views）。`npm run check` 通過。
- 2026-11-11: 0145 の入口を 501 で閉じた。読み先の Session DO（0146）と D1 の store ドライバ（0150）が
  未実装のため、0176 は 0150 / 0146 の後に着手する。