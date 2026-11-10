# 0063: ContractError に path を残す

> 後継: なし（0188 で対象が消えた）。

status: superseded
depends-on: 0037
touches: packages/core

## Goal

`ContractError.issues` は `path + ": " + message` の文字列に潰している。サーバは `ErrorResponse` の
`message` に詰められるが、web はフィールド単位でエラーを出せない。構造を保つ。

## Acceptance criteria

- [ ] `issues` を `{ path: string; message: string }[]` にする（`path` は空文字を許す）
- [ ] 既存の利用箇所（contract のテスト）を更新する
- [ ] サーバが `ErrorResponse` に写すときの形を docs に 1 行書く

## Notes

- HTTP のエラー本文は `ErrorResponse`（code/message）のまま。`issues` はログと UI のため。
- valibot の `issue.path` は `{ key }` の配列なので、`key` を文字列化する。

## Log

- 2026-11-07: 作成（コードレビューで path を捨てているのを見つけた）。
- 2026-11-10: 0188（D059）で REST 契約と core の schema / ContractError を撤去し、対象が無くなった。
