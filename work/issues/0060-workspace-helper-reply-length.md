# 0060: helper の応答に長さの検証を入れる

後継: 0190（workspace の低負債を一括で閉じる）。

status: superseded
depends-on: 0033
touches: packages/workspace

## Goal

`read` の応答は base64 文字列だけを返す。stdout が途中で切れても `JSON.parse` が通る形なら、
Node の base64 デコーダは不正な文字を黙って捨てるため、**壊れた内容がエラーなく読める**。
helper が `size` を返し、クライアントで照合する。

## Acceptance criteria

- [ ] helper の `read` 応答に `size`（バイト数）を足す
- [ ] クライアントで復号後の長さを照合し、違えば `failed("io")` にする
- [ ] 切断を模した応答で「壊れた内容を返さない」ことをテストで固定する

## Notes

- protocol の `HelperReply` は valibot で検証しているので、`size` を足すのは schema 1 行。
- 8 MiB 上限（`MAX_READ`）はそのまま。

## Log

- 2026-11-07: 作成（コードレビューで base64 の長さ検証が無いのを見つけた）。
- 2026-11-11: 0190 に吸収（superseded）。
