# 0053: operationId の検証位置を決める

status: open
depends-on: 0045
touches: packages/workspace, packages/core

## Goal

operationId を検証しているのは HTTP の境界（core の `OperationIdSchema`）だけ。workspace.write を
直接使う経路（agent の write_file ツールなど）では素通しになっている。規則は1つに保ったまま、
workspace の入口でも弾くかどうかを決め、決めた方針を実装する。

## Acceptance criteria

- [ ] `Workspace.write` の入口で core の `OperationIdSchema` を parse する（regex を複製しない）
- [ ] 不正な id は `Denied` で拒否し、0045 の回帰テストを「拒否」に戻す
- [ ] Vitest の `source` 条件と、build 後の dist の両方で解決できることを確認する
- [ ] workspace に同種の regex を置かない（二重定義をしない）ことをレビューで確認する

## Notes

- 0045 で temp 名を内部生成にしたため、**安全上は必須ではない**（operationId は journal のキーにしかならない）。
  これは API 契約を明確にするための判断。不要なら close して Result に理由を書く。
- 0035 の HTTP 入口は core の schema を使う。workspace の検証はその再利用であり、二重定義ではない。
- packages/workspace を触るので 0054 / 0055 と直列。

## やらないこと

- `OperationId` の brand 型導入（取り違えが実際に起きてから）。
- agent ツール側だけの独自検証（規則を増やす）。

## Log

- 2026-11-07: 作成（0045 の見直しで「HTTP だけ」と分かったため）。

- 2026-11-07: レビュー指摘への対応で、workspace は「同じ operationId を別の内容で使う」ことを `Denied` にし、
  agent の `write_file` はモデルから `operationId` を受け取らず `tool:<callId>` を内部生成するようにした。
  形式の検証（`OperationIdSchema` の parse）は本 issue のまま残す。
- 2026-11-07: agent が作る id を wire の書式（`[A-Za-z0-9_-]{1,64}`）に合わせた（`call-` + 整えた callId）。
  workspace の入口で `OperationIdSchema` を parse しても agent の経路が壊れない状態になった。
