# 0160: UI の配信（Workers Assets・typed client）

status: open
priority: next
design: agreed
design-ref: D094
depends-on: 0159
touches: packages/web/, packages/server/src/edge/, tools/deploy/, deploy/assets/

## Goal

UI を Worker から配信し、typed client を WS と組み合わせる。0036・0100 系の前提をこの形に合わせる。

## Acceptance criteria

- [ ] 静的アセットを Workers Assets で配信し、assets immutable / index no-cache にする
- [ ] typed client は Relay の codegen（0180）から生成し、WS は 0159 の別の口として持つ
- [ ] custom domain を既定にし、workers.dev は dev / CI にする
- [ ] `/graphql` は 401、画面はクライアントで `/login` にルーティングし、元の deep link に戻る
- [ ] XSS の面を確認（UI から exec に届くため、0158 / 0165 と突き合わせる）

## Notes

- PoC は run.mjs だけで UI を持たない。
- 0103〜0114 の画面はこの配信形態の上で作る。

## Design（D094 で合意）

2026-11-17 / ユーザーの設計レビューで合意（D094）。

### 前提

- 契約は **GraphQL**（D059 / 0188）。0037 の REST は撤去済みなので、AC の「typed client を 0037 から生成」は **Relay の codegen（0180）** に読み替える。
- edge は 0145。session は 0145 / D079。WS は 0159。
- Workers Assets で `packages/web/dist` を配る。

### 決定 1: 配信は Workers Assets + edge の fallback

- 既存 handler（0145）は `/graphql` POST / `/ws` GET / **static GET → `env.ASSETS`** / それ以外 404。0160 は static GET の分岐を拡張する。
- SPA fallback: `GET`/`HEAD` かつ `Accept: text/html` かつ `/assets`・`/api`・`/graphql`・`/ws` 以外で、ASSETS が 404 のとき `index.html` を返す。
- `/api/*` は現時点で face が無いので **404 のまま**（0125 / 0148 / 0157 が足す）。デバッグループを復活させない。`/assets/*` の未知は 404。
- `not_found_handling: single-page-application` は使わない（`/api` の 404 まで HTML になるため）。

### 既存コードとの突き合わせ

- `env.ASSETS` は optional（テストでは fake）。無いときは 404。
- 既存テスト「a static GET is public and delegated to ASSETS」「unknown static GET is 404」は、**navigation + `Accept: text/html` のときだけ index** に変える。`Accept` 無し / `/assets` は 404 のまま。
- CSP は index の HTML 応答に付ける（JSON / WS には不要）。
- `/api` は 0182 の face（0125 / 0148 / 0157）が入るまで 404。

### 決定 2: キャッシュ

- `assets/*`（ハッシュ付き）: `public, max-age=31536000, immutable`。
- `index.html`: `no-cache`（デプロイで即時に切り替える）。
- Service Worker は持たない。古い index を掴まない。

### 決定 3: typed client は Relay の生成物

- `schema.graphql`（0180 が生成）から relay-compiler の artifact を作り、web はそれだけを使う。手書きの client / ROUTES を足さない。
- WS は 0159 のまま別の口。Relay の subscription にはしない。

### 決定 4: ドメインと認証

- **custom domain を既定**にする（deploy の設定で指定）。`workers.dev` は dev / CI だけ。
- passkey の RP ID はその origin（D079）。tailnet のホスト名を製品の既定にしない。
- 未認証: `/graphql` は 401（typed）。SPA の画面は配信し、クライアントが `/login` にルーティングして元の deep link に戻す。edge で画面を redirect しない（assets の 404 と混ざる）。

### 決定 5: XSS とヘッダ

- CSP: `default-src 'self'`、`script-src 'self'`（Vite の hashed asset のみ。inline script なし）、`connect-src 'self'`（GraphQL / WS）、`img-src 'self' data:`、`style-src 'self' 'unsafe-inline'`（CSS 変数 / Base UI の inline style を許す範囲）。
- `X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin`、`Permissions-Policy` を絞る。
- 本文はテキストとして描画し、`dangerouslySetInnerHTML` を使わない。markdown を足すときは sanitize する（0158 / 0165）。
- production の source map は配らない（hidden で生成しても ASSETS に出さない）。

### 決定 6: 開発時の same-origin

- Vite の dev は `/graphql` / `/api` / `/ws` を `server.proxy` でローカルの server（8787）へ。`/ws` は `ws: true`。
- 現状の `packages/web/vite.config.ts` は proxy を持たない（コメントで「GraphQL の実装時に足す」と予告）。`tools/deploy/cloudflare.config.ts` にも `ASSETS` はまだ無い。0160 が両方を足す。
- cookie / passkey は same-origin で動かす。CORS を足さない。

### 決定（D094）

| ID | 論点 | 決定 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-01 | ドメイン | **決定（user）**: custom domain を既定。workers.dev は dev / CI | 0144 / 0158 / D079 | 2026-11-17 |
| U-02 | SPA fallback | **決定（user）**: edge で手動（API / assets を除外） | 0145 / 0160 | 2026-11-17 |
| U-03 | キャッシュ | **決定（user）**: assets immutable / index no-cache | 0043 / 0114 | 2026-11-17 |
| U-04 | 未認証 | **決定（user）**: `/graphql` 401、画面はクライアントで `/login` | 0108 / 0145 | 2026-11-17 |
| U-05 | source map | **決定（user）**: production では配らない | 0165 | 2026-11-17 |
| U-06 | typed client | **決定（user）**: Relay の codegen（0180）。0037 の記述を削除 | 0180 / 0037 | 2026-11-17 |

### テスト条件（案）

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | `/p/a/c/b` を GET（Accept: html）→ index。再読込 / deep link が通る | 高 | 受入1 |
| C2 | `/assets/<hash>.js` → 200、`immutable`。`/assets/missing.js` → 404（index でない）。`/unknown`（Accept なし）→ 404、`/unknown`（Accept: html）→ index | 高 | 受入1 |
| C3 | `/api/unknown` → JSON 404（HTML でない）。`/graphql` 未認証 → 401 | 高 | 受入1・4 |
| C4 | `index.html` → `no-cache`。デプロイ後に新しい index を取る | 中 | 受入1 |
| C5 | `/login` → 画面。ログイン後に元の deep link へ戻る | 高 | 受入4 |
| C6 | CSP / nosniff / referrer のヘッダ。production に source map が無い | 高 | 受入5 |
| C7 | dev の proxy で `/graphql` / `/api` / `/ws` が same-origin で通る | 中 | 受入2 |
| C8 | Relay の codegen が `schema.graphql` と一致する（0180 のゲート） | 中 | 受入2 |
| C9 | `npm run check` | 高 | — |

## Log

- 2026-11-17: D094 で合意。U-01〜U-06 を決定し、`design: agreed` にした。

## やらないこと

- 画面そのもの（0103〜0114）。
- Grabber（要件11）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
