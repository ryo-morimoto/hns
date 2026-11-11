# 0176: Worker に /graphql を載せる

status: open
priority: now
depends-on: 0145, 0146, 0150, 0175, 0188
touches: packages/server/src/graphql/, packages/server/test/

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
- 2026-11-11: 0145 の入口を 501 で閉じた。読み先の Session DO（0146）と D1 の store ドライバ（0150）が
  未実装のため、0176 は 0150 / 0146 の後に着手する。
