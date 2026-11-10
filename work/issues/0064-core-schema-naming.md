# 0064: スキーマの id と名前の命名を分ける

> 後継: なし（0188 で対象が消えた）。

status: superseded
depends-on: 0037
touches: packages/core

## Goal

`http-schemas.ts` は `id`（`minLength(1)` の文字列）を `name` や `title` にも使っている。識別子と
表示名が同じ検証を共有していることが読み取りにくい。名前を分ける。

## Acceptance criteria

- [ ] 識別子は `id`、表示名は `nonEmpty`（または `name`）に分ける
- [ ] 空文字を拒否する規則は変えない（挙動は同じ）
- [ ] 全スキーマで命名が揃っていることをレビューで確認する

## Notes

- 挙動は変えない。読み手が「これは ID か」と迷わないようにするだけ。
- `title` に改行や制御文字を許すかは別の判断（今は `minLength(1)` のみ）。

## Log

- 2026-11-07: 作成（コードレビューで `id` を名前にも使っているのを見つけた）。
- 2026-11-10: 0188（D059）で REST 契約と core の schema / ContractError を撤去し、対象が無くなった。
