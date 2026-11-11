# 0145: Worker の入口（認証境界・ルーティング・相関 ID）

status: done
priority: now
depends-on: 0144, 0188
touches: packages/server/, tools/deploy/cloudflare.config.ts, tools/deploy/config.test.ts, tools/deploy/worker.ts, vitest.config.ts, oxlint.config.ts, package-lock.json, docs/{auth,observability,engineering,packages}.md, AGENTS.md, work/issues/0145-worker-edge.md, work/issues/0176-graphql-endpoint.md, work/BOARD.md, work/LANES.md, work/findings/findings.jsonl

## Goal

公開される Worker を1つに絞り、入口で認証・認可・相関 ID を付けてから Session DO か D1 に渡す。
「UI の状態を信じない」を境界で徹底する。

## Acceptance criteria

- [x] 面は「静的配信」「GraphQL（`POST /graphql`）」「WS（`/ws`）」の3つだけ。それ以外は 404
- [x] 認証はセッション cookie（passkey は 0158）。未認証は 401 で fail closed
- [x] すべてのリクエストに相関 ID を付け、DO とマシンまで通す
- [x] 1リクエストの上限（body / 時間 / 行）を決めて実装
- [x] CORS は既定で閉じる。デバッグ用の口を残さない
- [x] DO は公開しない（バインディングのみ）
- [x] D1 へのアクセスもこの Worker に閉じる（DO から直接 D1 を触らない）

## Notes

- REST の面は、実装する issue が schema・認証・handler を同じ変更で足す（D059）。0145 は REST を持たない。
- PoC の `/api/debug` のような口は製品では作らない。
- レート制限はアプリで持たない。Cloudflare 側のレート制限と、body / 時間 / 行 / 0176 の複雑度上限に任せる（0145 は body / 時間 / 行だけを持つ）。
- セッション cookie は `hns_session`。値は `<base64url(payload)>.<base64url(HMAC-SHA256(payload))>`、payload は `{v:1,sub,exp}`。検証は 0145、発行と属性は 0158。
- 相関 ID のヘッダは `x-request-id`（[docs/observability.md](../../docs/observability.md)）。受信値は形式を検査して引き継ぎ、不正なら生成する。
- 静的配信の実体（Assets の設定）は 0160。0145 は `ASSETS` binding があればそこへ渡す。無ければ 404。
- 0145 の `/graphql` は 501、`/ws` も DO スタブの 501。0176 / 0159 が中身を差し替える。

## テスト条件（Example Mapping）

- 規則: 公開面は GraphQL / WS / 静的の3つだけ。それ以外は 404 か 405。
  - 例: `GET /graphql` は 405（`Allow: POST`）。`OPTIONS /graphql` は 405 で CORS ヘッダを付けない。
  - 例: `POST /api/debug` と `GET /api/debug` は 404。`POST /` は 404。`/graphql/` は面ではない。
- 規則: データ面はセッション cookie が無ければ実行しない（fail closed）。
  - 例: `POST /graphql` に cookie が無いと 401 で、GraphQL handler は呼ばれない。
  - 例: 期限切れ・改ざん・別秘密・`HNS_SESSION_SECRET` 未設定・短すぎる秘密・重複 cookie は 401。
  - 例: 静的 `GET /` は cookie 無しで ASSETS に渡る（ログイン画面が読める）。
- 規則: 相関 ID は全リクエストに付き、下流へ渡る。
  - 例: 未指定なら UUID を生成し、レスポンスの `x-request-id` に返す。
  - 例: 妥当な受信値は引き継ぐ。改行・制御文字・長すぎる値は捨てて生成する。
  - 例: `/ws` の DO への要求ヘッダが、レスポンスの `x-request-id` と一致する。
- 規則: 上限は境界で止める。
  - 例: 1 MiB 超の body は 413。`Content-Length` が嘘でもストリームで数えて 413。
  - 例: 10 秒を超えた handler は 504 で、`signal` は abort 済み。
  - 例: 行予算 500 を超えると `spend` が false。リスト上限は 100。
- 規則: CORS は既定で閉じ、デバッグ用の口を残さない。
  - 例: どの応答にも `Access-Control-Allow-Origin` が無い。`/api/*` は 404。
- 規則: DO は面にしない。D1 は Worker だけが触る。
  - 例: `SESSION` を使うのは `/ws` の転送だけ。0145 に D1 の読み書きは無い（0150 / 0146 が守る）。

## テスト設計

- 層: unit / contract。`packages/server/src/edge/*.test.ts` が `Request` と `Response` を直接渡す。workerd もネットワークも使わない。
- support: `packages/server/test/support/edge.ts` に cookie 発行、env、ASSETS / SESSION の fake を置く。
- `session.test.ts`: sign → verify の往復、期限切れ、改ざん、別秘密、短い秘密、未設定、重複 cookie、不正な base64 / JSON / `v`。
- `body.test.ts`: 上限内、宣言超過、ストリーム超過、JSON 以外、charset 付き JSON。
- `limits.test.ts`: 行予算の境界（0 / ちょうど / 超過 / 負値）。
- `handler.test.ts`: ルーティング表、401、405 + `Allow`、404、413、415、504 + abort、静的委譲、`/api/*` 404、CORS 無し、相関 ID の生成・引き継ぎ、`/ws` の DO 転送ヘッダ、`SESSION` 不在 503、例外 500。
- `worker.test.ts`: 本番組み立てで `POST /graphql` が 501、`/ws` が 501、認証失敗が 401。
- 回帰テストには `// Catches: <壊れたときの症状>` を付ける。
- workerd 固有の Assets / DO の挙動は dry-run と `cf dev` の smoke で確認し、確認できないものは Result の「未確認」に書く。

## やらないこと

- passkey そのもの（0158）。
- 一覧 API（0149）。
- GraphQL の schema / resolver / 上限（0176）。0145 では `/graphql` を 501 に閉じる。
- WS のメッセージ型と再接続（0159）。0145 では DO へ転送し、DO スタブが 501 を返す。
- 静的アセットの配信設定（0160）。0145 は `ASSETS` binding があれば配る入口だけを持つ。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
- 2026-11-10: D059 により、入口を GraphQL / WS / 静的の3面にした。REST は面ごとの issue が持つ。
- 2026-11-11: 0144 の tools/deploy/worker.ts を packages/server/src/edge/worker.ts の re-export にする
  （cloudflare.config.ts の entrypoint は worker.ts のまま）。
- 2026-11-11: 実装開始。3面の入口・セッション cookie 検証・`x-request-id`・body / 時間 / 行の上限。
  GraphQL（0176）と WS（0159）の中身、静的 Assets（0160）は後続に渡す。
- 2026-11-11: 0176 は Session DO（0146）と D1 の store ドライバ（0150）が無いため、0150 / 0146 の後に回す。
- 2026-11-11: edge を実装。45 unit/contract tests。`npm run check` は 247 tests / build / deploy dry-run / knip 通過。
  workerd smoke（cf の build 成果物を wrangler dev で起動）: `/graphql` は cookie 無し 401 → cookie 有り 501、
  `/ws` は 401 → DO スタブ 501、`/api/debug` 404、`GET /graphql` 405、`x-request-id` の引き継ぎを確認。
  `cf dev` はこの環境で起動直後に終了するため、smoke は build 成果物を直接使った。

## Result

- verdict: **PASS**（blocking 0）
- reviewer: reviewer-0145（この変更を書いていない別エージェント）
- HEAD: b67262e（実装 commit。review は 2b59c82 + 作業ツリーの最終状態をハッシュ固定して実施）
- 受入: 7/7。`npm run check` は 247 tests / 49 files、lint / fmt / typecheck / build / deploy dry-run / knip がすべて ok。
  回帰検出力は変異で確認（重複 cookie 拒否・署名検証・認証スキップ・Content-Length・ストリーム上限・deadline abort・
  request-id 形式・x-request-id 付与のどれかを壊すと 1〜8 本が落ちる）。
- workerd smoke: cf build の成果物を wrangler dev で起動し、`/graphql` 401 → cookie 有り 501、`/ws` 401 → DO スタブ 501、
  `/api/debug` 404、`GET /graphql` 405、`x-request-id` の引き継ぎを確認。`cf dev` 自体はこの環境で起動直後に終了する。
- blocking: なし。
- non-blocking（`work/findings/findings.jsonl` F-0026〜F-0029）:
  - docs/packages.md の `bin`（hns）が package.json に無い（docs が実装より強い）。
  - bearer token の回帰テストのコメントが query token も含むと言うが assert は bearer のみ。
  - request-id の不正値テストが空白入り1件だけで、129文字・制御文字を assert していない。
  - 101 応答の `x-request-id` スキップと forwarded request のヘッダはテスト未固定（WS 実装時に確認）。
- 未確認: 実際の WebSocket upgrade（101）を `new Request(...)` で DO へ転送する経路、ASSETS の notFoundHandling /
  SPA fallback の実設定（0160）、`cf dev` + `.dev.vars` の secret 供給、本番 deploy で HNS_SESSION_SECRET が
  binding されること（dry-run は secret 一覧を出さない）。
- 行上限は値を決めて `RowBudget` と `DEFAULT_LIMITS` を実装し、resolver への配線は 0176 に渡す（0145 の受入は「決めて実装」まで）。
