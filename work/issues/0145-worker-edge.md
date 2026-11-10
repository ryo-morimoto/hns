# 0145: Worker の入口（認証境界・ルーティング・相関 ID）

status: open
priority: now
depends-on: 0144, 0188
touches: packages/server/src/edge/, packages/server/test/

## Goal

公開される Worker を1つに絞り、入口で認証・認可・相関 ID を付けてから Session DO か D1 に渡す。
「UI の状態を信じない」を境界で徹底する。

## Acceptance criteria

- [ ] 面は「静的配信」「GraphQL（`POST /graphql`）」「WS（`/ws`）」の3つだけ。それ以外は 404
- [ ] 認証はセッション cookie（passkey は 0158）。未認証は 401 で fail closed
- [ ] すべてのリクエストに相関 ID を付け、DO とマシンまで通す
- [ ] 1リクエストの上限（body / 時間 / 行）を決めて実装
- [ ] CORS は既定で閉じる。デバッグ用の口を残さない
- [ ] DO は公開しない（バインディングのみ）
- [ ] D1 へのアクセスもこの Worker に閉じる（DO から直接 D1 を触らない）

## Notes

- REST の面は、実装する issue が schema・認証・handler を同じ変更で足す（D059）。0145 は REST を持たない。
- PoC の `/api/debug` のような口は製品では作らない。
- レート制限は Cloudflare 側の機能で足りるか、アプリで持つかを決める。

## やらないこと

- passkey そのもの（0158）。
- 一覧 API（0149）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
- 2026-11-10: D059 により、入口を GraphQL / WS / 静的の3面にした。REST は面ごとの issue が持つ。
- 2026-11-11: 0144 の tools/deploy/worker.ts を packages/server/src/edge/worker.ts の re-export にする
  （cloudflare.config.ts の entrypoint は worker.ts のまま）。
