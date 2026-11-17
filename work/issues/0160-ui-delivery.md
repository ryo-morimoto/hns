# 0160: UI の配信（Workers Assets・typed client）

status: done
priority: now
design: agreed
design-ref: D094
depends-on: 0159
touches: packages/web/, packages/server/src/edge/, tools/deploy/, deploy/assets/, .gitignore, work/issues/0160-ui-delivery.md

## Goal

UI を Worker から配信し、typed client を WS と組み合わせる。0036・0100 系の前提をこの形に合わせる。

## Acceptance criteria

- [x] 静的アセットを Workers Assets で配信し、assets immutable / index no-cache にする
- [x] typed client は Relay の codegen（0180）から生成し、WS は 0159 の別の口として持つ
- [x] custom domain を既定にし、workers.dev は dev / CI にする
- [x] `/graphql` は 401、画面はクライアントで `/login` にルーティングし、元の deep link に戻る
- [x] XSS の面を確認（UI から exec に届くため、0158 / 0165 と突き合わせる）

- 2026-11-17: 0127 の後に lead が `next` から `now` へ。UI を Worker から配信し、typed client と WS を組み合わせる。

## Notes

- PoC は run.mjs だけで UI を持たない。
- 0103〜0114 の画面はこの配信形態の上で作る。

## Design（D094 で合意）

2026-11-17 / ユーザーの設計レビューで合意（D094）。

### 前提

- 契約は **GraphQL**（D059 / 0188）。0037 の REST は撤去済みなので、AC の「typed client を 0037 から生成」は **Relay の codegen（0180）** に読み替える。
- edge は 0145。session は 0145 / D079。WS は 0159。
- Workers Assets で web の build 出力を配る（実装では `deploy/assets`、`tools/deploy/wrangler.config.ts` の `assetsDirectory`）。

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
- 設計時点の `packages/web/vite.config.ts` は proxy を持たず、`tools/deploy/cloudflare.config.ts` にも `ASSETS` が無かった。0160 が両方を足した（上の「実装」）。
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

## 実装（2026-11-17）

- **配信**: `tools/deploy/wrangler.config.ts` が `assetsDirectory: "../../deploy/assets"` を指す。
  `cloudflare.config.ts` の `worker.assets` は `notFoundHandling: "none"` / `runWorkerFirst: true`、
  `env.ASSETS` は `bindings.assets()`。`packages/web/vite.config.ts` の `build.outDir` は `deploy/assets`
  （`emptyOutDir` / sourcemap なし）。`deploy/assets/` は gitignore。
- **edge の fallback**: `GET`/`HEAD` は GraphQL / WS / files / observability / `/api` を先に処理し、
  残りを `ASSETS` へ流す。`ASSETS` が 404 かつ `Accept: text/html` かつ `/assets`・`/api`・
  `/graphql`・`/ws` 以外のときだけ `/index.html` を返す。`/assets/*` は
  `public, max-age=31536000, immutable`、HTML は `no-cache`。
- **ヘッダ**: HTML に CSP（D094 の directive）・`X-Content-Type-Options: nosniff`・
  `Referrer-Policy: same-origin`・`Permissions-Policy`。production の source map は生成も配布もしない。
- **domain**: staging / production は `HNS_DOMAIN` 必須で `domains: [host]` / `workersDev: false`。
  development は `workersDev: true` で domain なし。`previewUrls: false`。`deploy.sh` は web build を
  先に走らせる。
- **typed client**: 既存の relay-compiler artifact（0180 の codegen stage）をそのまま使い、WS は
  `/ws` の別口（0159）。手書き client を足さない。
- **401**: `createEnvironment({ onUnauthorized })` が 401 で
  `/login?next=<pathname+search+hash>` に遷移し、`nextPathFrom` が同一 origin のパスだけ復元する。
  ログイン画面は 0108 が持ち、この issue は配線と戻り先の検証まで。
- **XSS**: web の描画に `dangerouslySetInnerHTML` / `innerHTML` 等の sink が無いことを確認し、
  model の文字列がテキストで出ることを jsdom で固定した。exec 側の受け口は 0158 / 0165。

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | `/p/a/c/b` を GET（Accept: html）→ index。再読込 / deep link が通る | 高 | 受入1 |
| C2 | `/assets/<hash>.js` → 200、`immutable`。`/assets/missing.js` → 404（index でない）。`/unknown`（Accept なし）→ 404、`/unknown`（Accept: html）→ index | 高 | 受入1 |
| C3 | `/api/unknown` → JSON 404（HTML でない）。`/graphql` 未認証 → 401。`/graphql` / `/ws` / `/assets` は fallback しない | 高 | 受入1・4 |
| C4 | `index.html` / SPA fallback → `no-cache`。デプロイ後に新しい index を取る | 中 | 受入1 |
| C5 | 401 → クライアントが `/login?next=...` に遷移し、`nextPathFrom` が元の deep link を返す。`/login` 自身では再遷移しない（画面は 0108） | 高 | 受入4 |
| C6 | HTML に CSP / nosniff / referrer / permissions のヘッダ。production に source map が無い | 高 | 受入5 |
| C7 | dev の proxy で `/graphql` / `/api` / `/ws` が same-origin で通る | 中 | 受入2 |
| C8 | Relay の codegen が `schema.graphql` と一致する（0180 のゲート） | 中 | 受入2 |
| C9 | `<img onerror>` / `<script>` を含む model の文字列 → 画面 → 実行されずテキストで出る。HTML 注入 sink が無い | 高 | 受入5 |
| C10 | staging / production → custom domain、`workersDev: false`。development → workers.dev。`ASSETS` binding と `deploy/assets` が一致 | 高 | 受入1・3 |
| C11 | `npm run check` | 高 | — |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 | 同値分割（navigation / non-navigation） | unit | `packages/server/src/edge/handler.test.ts` "a navigation to an unknown path is answered with the no-cache shell" |
| T2 | C2 | 境界値（hashed / missing / non-HTML） | unit | 同 "a hashed asset is immutable and a missing asset stays a 404" / "only a navigation falls back to the shell" |
| T3 | C3 | デシジョンテーブル（face × method × Accept） | unit | 同 "the faces and /assets are never answered by the shell" + 既存の 401 / 405 |
| T4 | C4 | 契約（cache header） | unit | 同 C1 / "the root document is revalidated" / "GET /login is served the shell" |
| T5 | C5 | 状態遷移（401 → login → return） | unit（jsdom） | `packages/web/src/auth/login.test.ts`、`packages/web/src/relay/environment.test.ts` |
| T6 | C6 | 契約（ヘッダ）/ 構成 | unit | `handler.test.ts` の C1 + `packages/web/src/config.test.ts` |
| T7 | C7 | 構成（proxy） | unit | `packages/web/src/config.test.ts` "development proxies..." |
| T8 | C8 | 生成の一致 | static | `npm run check` の codegen stage / `tools/codegen/verify.ts` |
| T9 | C9 | 故障注入（markup）/ 静的検査 | component + static | `packages/web/src/app/xss.test.tsx` |
| T10 | C10 | 構成（domain / workers.dev / assets） | unit | `tools/deploy/config.test.ts` + `cf deploy --dry-run` の worker.config.json |
| T11 | C11 | ゲート | static | `npm run check` |

## やらないこと

- 画面そのもの（0103〜0114）。
- Grabber（要件11）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
- 2026-11-17: 実装。Workers Assets（`tools/deploy/wrangler.config.ts` の `deploy/assets`、`ASSETS` binding、
  `runWorkerFirst`）、edge の手動 SPA fallback と immutable / no-cache、custom domain（`HNS_DOMAIN`）と
  workers.dev の切替、Vite proxy、401 → `/login?next=` の配線、XSS の確認。`npm run check` exit 0
  （829 tests / 128 files、38.4s）。`cf deploy --dry-run` は development / production とも exit 0 で、
  production の Build Output は `domains:["hns.example.com"]` / `workersDev:false` / `ASSETS` を含む。
  `deploy/assets` は hashed JS/CSS と index のみで `.map` を持たない。ログイン画面は 0108 の担当で、
  この issue は遷移と復帰先の配線まで（画面は実装していない）。独立レビューは未割当で、status は
  `in-progress` のまま。
- 2026-11-17: `cf dev --mode development` で実配信を確認。`/` / `/p/a/c/b` / `/login` は 200 の index に
  `Cache-Control: no-cache` と CSP / nosniff / Referrer-Policy / Permissions-Policy、`/assets/index-*.js` は
  200 に `public, max-age=31536000, immutable`、`/assets/missing.js` は 404（index でない）。
  `POST /graphql` は 401（`application/problem+json`）、`GET /graphql` は 405、`/api/unknown` は JSON 404。

- 2026-11-17: D094 で合意。U-01〜U-06 を決定し、`design: agreed` にした。
- 2026-11-17: reviewer-0160 PASS（blocking 0）。main へ ff 統合（da1484a）。main の gate は exit 0（829 tests / 39.7s）。

## Result

- verdict: **PASS**（reviewer-0160、blocking 0）
- reviewer: reviewer-0160（この変更を書いていない別エージェント）
- HEAD: da1484a（main に ff 統合）
- 受入: 5/5。gate は exit 0（829 tests / 128 files、main で 39.7s）。
- 確認: deploy/assets の index + hashed JS/CSS（.map なし）、index no-cache / asset immutable / 未知 asset 404、SPA fallback が /graphql・/api・/ws を飲み込まない、custom domain 既定（HNS_DOMAIN 必須・fail closed）/ workers.dev は development のみ、POST /graphql 401 problem+json・GET 405・/api 404 JSON、401 → /login?next= と同一 origin の nextPathFrom、XSS の描画テストと sink の静的検査、CSP / nosniff / Referrer-Policy / Permissions-Policy。
- 非 blocking（低 8、follow-up）: onUnauthorized が 401 ごとに呼ばれる（TSDoc は once）/ nextPathFrom の control char 分岐が未テスト / cloudflare.config の workersDev が domain 欠落で fail open になり得る（実経路は customDomainFor が fail closed）/ Accept の Vary と 404 の cache 指示 / 製品コメントの issue 番号 / nextPathFrom の呼び出しがテストのみ（0108 で再利用・touches 追記）/ docs/web-client-nfr の出力先が dist のまま / deploy stage の dry-run が development のみ。
- 未確認: 実 deploy / DNS、実ブラウザの CSP 下の WS、401 → /login → deep link の E2E（画面は 0108）。
