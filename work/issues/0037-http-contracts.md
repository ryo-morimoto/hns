# 0037: HTTP 契約と型付きクライアント

status: open
depends-on: 0031
touches: packages/core, packages/web

## Goal

全 API の入出力を valibot schema にし、server と web が同じ型を使う。

## Acceptance criteria

- [ ] 全エンドポイントの request / response schema（`GenericSchema<unknown, T>`）
- [ ] SSE イベントも型にする
- [ ] server は入口で必ず parse する
- [ ] web はレスポンス型を手書きしない
