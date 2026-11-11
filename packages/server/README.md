# @hns/server

Worker の入口。公開する面を GraphQL / WS / 静的の3つに絞り、境界でセッション cookie・相関 ID・上限を扱う。

- `src/edge/worker.ts` — 本番の組み立て。`/graphql` は 501、`/ws` は Session DO へ転送する（DO は 501）。
- `src/edge/handler.ts` — `createEdge(deps, limits)`。ルーティング、認証、相関 ID、時間制限。
  GraphQL と WS の handler は引数で差し替える。
- `src/edge/session.ts` — `hns_session` の署名・検証。値は `<base64url(payload)>.<base64url(HMAC-SHA256(payload))>`。
- `src/edge/correlation.ts` — `x-request-id`。受信値は形式を検査して引き継ぎ、不正なら生成する。
- `src/edge/body.ts` — JSON body の上限付き読み取り。`Content-Length` とストリームの両方で数える。
- `src/edge/limits.ts` — 1 MiB / 10 秒 / 500 行（1リクエスト）/ 100 行（1リスト）と `RowBudget`。
- `src/edge/problem.ts` — `application/problem+json` と閉じた `code` union。
- `src/edge/env.ts` — edge が使う Cloudflare バインディングの最小構造型。

## 面

| パス       | メソッド       | 認証              | 動作                                     |
| ---------- | -------------- | ----------------- | ---------------------------------------- |
| `/graphql` | `POST`         | セッション cookie | 0145 では 501。schema / resolver は 0176 |
| `/ws`      | `GET`          | セッション cookie | Session DO へ転送。メッセージは 0159     |
| それ以外   | `GET` / `HEAD` | 不要              | `ASSETS` へ委譲。配信設定は 0160         |
| `/api/*`   | すべて         | —                 | 404                                      |

`OPTIONS` は 405 で、CORS ヘッダは返さない。デバッグ用の口は作らない。
`ASSETS` の `notFoundHandling` は SPA fallback にしない（画面は hash router）。未知のパスを 200 にしない設定は 0160 が持つ。

## セッション

- cookie 名は `hns_session`。payload は `{v:1,sub,exp}`（`exp` は秒）。
- `HNS_SESSION_SECRET`（32文字以上）で HMAC-SHA256 を検証する。未設定・短い・期限切れ・改ざん・重複は 401。
- `Set-Cookie` の属性（`Secure` / `HttpOnly` / `SameSite=Lax` / 30日）は 0158 が付ける。

## Durable Object と D1

- DO は HTTP の面にしない。`/ws` だけが `SESSION` binding の `default` へ転送する。
  `default` は単一ワークスペースの暫定 ID。ワークスペース選択が入ったら置き換える。
- D1 は Worker だけが触る。DO から D1 を直接触らない（0150 / 0146）。

0145 の edge は `@hns/core` を使わない。GraphQL の型を足すときに依存を追加する（0150 / 0146 の後）。

## 開発

```bash
npm test -w @hns/server
npm run typecheck -w @hns/server
npm run build -w @hns/server
```

配備の入口は [tools/deploy/worker.ts](../../tools/deploy/worker.ts)。edge を re-export し、
Session DO のスタブを置いている。`cf dev` では `HNS_SESSION_SECRET` を `.dev.vars` に置く（git に入れない）。
